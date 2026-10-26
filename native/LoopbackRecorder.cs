// LoopbackRecorder.cs — WASAPI loopback capture of a Windows render endpoint.
//
// Writes canonical PCM WAV (default 16000 Hz / mono / 16 bit), which is exactly
// what the DSH speech-to-text pipeline accepts. Emits line-delimited JSON on
// stdout so a host process can follow levels and the final result.
//
// Build (offline, no SDK):
//   %WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize+ /target:exe
//       /platform:anycpu /out:LoopbackRecorder.exe LoopbackRecorder.cs
//
// Modes:
//   LoopbackRecorder.exe --list-devices
//   LoopbackRecorder.exe --capture --out <file.wav> [--seconds 30] [--device <id>]
//                        [--rate 16000] [--channels 1] [--bits 16]
//                        [--levels] [--silence-stop 1500] [--silence-threshold 0.006]
//                        [--stop-file <path>]
//   LoopbackRecorder.exe --repair <file.wav>
//
// Language level: C# 5 (.NET Framework 4.0 compiler) — no string interpolation,
// no expression-bodied members, no auto-property initializers.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DshSystemAudio
{
    internal static class Program
    {
        // ---- WASAPI constants -------------------------------------------------
        private const int DeviceStateActive = 0x1;

        private const int DataFlowRender = 0;
        private const int DataFlowCapture = 1;
        private const int RoleConsole = 0;

        private const int ShareModeShared = 0;
        private const int StreamFlagsLoopback = 0x00020000;
        private const int StreamFlagsAutoConvertPcm = unchecked((int)0x80000000);
        private const int StreamFlagsSrcDefaultQuality = 0x08000000;

        private const int BufferFlagsSilent = 0x2;

        private static readonly Guid ClsidMmDeviceEnumerator = new Guid("BCDE0395-E52F-467C-8E3D-C4579291692E");
        private static readonly Guid IidAudioClient = new Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2");
        private static readonly Guid IidAudioCaptureClient = new Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317");

        private static readonly PropertyKey PkeyDeviceFriendlyName =
            new PropertyKey(new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), 14);

        private const int StgmRead = 0;
        private const int ClsCtxAll = 23;
        private const int WaitTimeout = 0x00000102;

        private static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

        // Always emit UTF-8 regardless of the console code page, so the host can
        // parse device names and file paths as UTF-8 JSON.
        private static readonly Stream Stdout = Console.OpenStandardOutput();
        private static readonly Stream Stderr = Console.OpenStandardError();

        // Event channel. Normally stdout; in stream mode (--out -) stdout carries
        // the raw WAV bytes instead, so the events move to stderr.
        private static Stream EventStream = Stdout;

        private static void Emit(string line)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(line + "\n");
            EventStream.Write(bytes, 0, bytes.Length);
            EventStream.Flush();
        }

        // Set once the parent closes our stdin. `--stop-on-stdin` turns that into
        // a graceful stop, which lets a caller end a capture without any shared
        // file: a confined sandbox denies a spawned process most filesystem
        // access, but an inherited stdin handle is always available.
        private static volatile bool StdinClosed;

        private static void StartStdinWatcher()
        {
            Thread watcher = new Thread(delegate()
            {
                try
                {
                    Stream input = Console.OpenStandardInput();
                    byte[] scratch = new byte[256];
                    while (input.Read(scratch, 0, scratch.Length) > 0)
                    {
                    }
                }
                catch (Exception)
                {
                }
                StdinClosed = true;
            });
            watcher.IsBackground = true;
            watcher.Start();
        }

        // ---- COM interfaces ---------------------------------------------------
        [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceEnumerator
        {
            int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
            int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
            int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
            int RegisterEndpointNotificationCallback(IntPtr client);
            int UnregisterEndpointNotificationCallback(IntPtr client);
        }

        [ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDeviceCollection
        {
            int GetCount(out int count);
            int Item(int index, out IMMDevice device);
        }

        [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IMMDevice
        {
            int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
                         [MarshalAs(UnmanagedType.IUnknown)] out object iface);
            int OpenPropertyStore(int stgmAccess, out IPropertyStore properties);
            int GetId(out IntPtr id);
            int GetState(out int state);
        }

        [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IPropertyStore
        {
            int GetCount(out int count);
            int GetAt(int index, out PropertyKey key);
            int GetValue(ref PropertyKey key, out PropVariant value);
            int SetValue(ref PropertyKey key, ref PropVariant value);
            int Commit();
        }

        [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioClient
        {
            int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity,
                           IntPtr format, IntPtr audioSessionGuid);
            int GetBufferSize(out int bufferFrames);
            int GetStreamLatency(out long latency);
            int GetCurrentPadding(out int paddingFrames);
            int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
            int GetMixFormat(out IntPtr format);
            int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
            int Start();
            int Stop();
            int Reset();
            int SetEventHandle(IntPtr handle);
            int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
        }

        [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
        private interface IAudioCaptureClient
        {
            int GetBuffer(out IntPtr data, out int frames, out int flags,
                          out long devicePosition, out long qpcPosition);
            int ReleaseBuffer(int frames);
            int GetNextPacketSize(out int packets);
        }

        // ---- COM structs ------------------------------------------------------
        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct WaveFormatEx
        {
            public ushort FormatTag;
            public ushort Channels;
            public uint SamplesPerSec;
            public uint AvgBytesPerSec;
            public ushort BlockAlign;
            public ushort BitsPerSample;
            public ushort CbSize;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 1)]
        private struct PropertyKey
        {
            public Guid FormatId;
            public int PropertyId;
            public PropertyKey(Guid formatId, int propertyId)
            {
                FormatId = formatId;
                PropertyId = propertyId;
            }
        }

        [StructLayout(LayoutKind.Explicit, Size = 24)]
        private struct PropVariant
        {
            [FieldOffset(0)]
            public short VariantType;
            [FieldOffset(8)]
            public IntPtr PointerValue;
        }

        [DllImport("ole32.dll")]
        private static extern int PropVariantClear(ref PropVariant value);

        // ---- entry point ------------------------------------------------------
        private static int Main(string[] args)
        {
            try
            {
                return Run(args);
            }
            catch (Exception error)
            {
                EmitError(error.Message);
                Console.Error.WriteLine("LoopbackRecorder: " + error);
                return 1;
            }
        }

        private static int Run(string[] args)
        {
            Options options = Options.Parse(args);

            if (options.Out == "-")
            {
                // Stream mode: the caller reads the WAV from our stdout, so the
                // child process never needs to create a file (required inside a
                // confined sandbox where a spawned process cannot write). The
                // line-delimited events move to stderr to keep stdout binary.
                options.Stream = true;
                EventStream = Stderr;
            }

            if (options.OutTemp != null && options.Out == null)
            {
                // Resolve the output inside the CHILD's own temp directory. A
                // confined sandbox grants a spawned process its private temp
                // root, so this stays writable where an explicit path under the
                // real user Temp is denied. The absolute path is reported back
                // in the `start` and `done` events.
                options.Out = Path.Combine(Path.GetTempPath(), options.OutTemp);
            }

            if (options.ListDevices)
            {
                ListDevices();
                return 0;
            }

            if (options.Repair != null)
            {
                RepairWave(options.Repair);
                return 0;
            }

            if (options.Out == null)
            {
                EmitError("--out <file.wav> is required");
                return 2;
            }

            if (options.StopOnStdin)
                StartStdinWatcher();

            Capture(options);
            return 0;
        }

        // ---- device enumeration ----------------------------------------------
        private static IMMDeviceEnumerator CreateEnumerator()
        {
            Type type = Type.GetTypeFromCLSID(ClsidMmDeviceEnumerator, true);
            return (IMMDeviceEnumerator)Activator.CreateInstance(type);
        }

        private static string DeviceIdOf(IMMDevice device)
        {
            IntPtr pointer;
            device.GetId(out pointer);
            try
            {
                return Marshal.PtrToStringUni(pointer);
            }
            finally
            {
                Marshal.FreeCoTaskMem(pointer);
            }
        }

        private static string FriendlyNameOf(IMMDevice device)
        {
            try
            {
                IPropertyStore store;
                if (device.OpenPropertyStore(StgmRead, out store) != 0 || store == null)
                    return null;
                try
                {
                    PropertyKey key = PkeyDeviceFriendlyName;
                    PropVariant value;
                    if (store.GetValue(ref key, out value) != 0)
                        return null;
                    try
                    {
                        if (value.VariantType != 31 || value.PointerValue == IntPtr.Zero)
                            return null;
                        return Marshal.PtrToStringUni(value.PointerValue);
                    }
                    finally
                    {
                        PropVariantClear(ref value);
                    }
                }
                finally
                {
                    Marshal.ReleaseComObject(store);
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private static void ListDevices()
        {
            IMMDeviceEnumerator enumerator = CreateEnumerator();
            StringBuilder builder = new StringBuilder();
            string defaultId = null;
            try
            {
                IMMDevice fallback;
                if (enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleConsole, out fallback) == 0)
                {
                    defaultId = DeviceIdOf(fallback);
                    Marshal.ReleaseComObject(fallback);
                }
            }
            catch (Exception)
            {
            }

            IMMDeviceCollection collection;
            enumerator.EnumAudioEndpoints(DataFlowRender, DeviceStateActive, out collection);
            int count;
            collection.GetCount(out count);

            builder.Append("{\"event\":\"devices\",\"default\":");
            builder.Append(Json(defaultId));
            builder.Append(",\"devices\":[");
            bool first = true;
            for (int index = 0; index < count; index++)
            {
                IMMDevice device;
                collection.Item(index, out device);
                try
                {
                    string id = DeviceIdOf(device);
                    string name = FriendlyNameOf(device);
                    int state;
                    device.GetState(out state);
                    if (!first)
                        builder.Append(',');
                    first = false;
                    builder.Append("{\"id\":");
                    builder.Append(Json(id));
                    builder.Append(",\"name\":");
                    builder.Append(Json(name == null ? id : name));
                    builder.Append(",\"default\":");
                    builder.Append(id != null && id == defaultId ? "true" : "false");
                    builder.Append('}');
                }
                finally
                {
                    Marshal.ReleaseComObject(device);
                }
            }
            builder.Append("]}");
            Emit(builder.ToString());
            Marshal.ReleaseComObject(collection);
            Marshal.ReleaseComObject(enumerator);
        }

        private static IMMDevice OpenRenderDevice(Options options)
        {
            IMMDeviceEnumerator enumerator = CreateEnumerator();
            try
            {
                if (options.DeviceId != null)
                {
                    IMMDevice chosen;
                    enumerator.GetDevice(options.DeviceId, out chosen);
                    return chosen;
                }
                IMMDevice endpoint;
                enumerator.GetDefaultAudioEndpoint(DataFlowRender, RoleConsole, out endpoint);
                return endpoint;
            }
            finally
            {
                Marshal.ReleaseComObject(enumerator);
            }
        }

        // ---- capture ----------------------------------------------------------
        private static void Capture(Options options)
        {
            IMMDevice device = OpenRenderDevice(options);
            IAudioClient client = null;
            IAudioCaptureClient capture = null;
            WaveSink sink = null;
            try
            {
                string deviceId = DeviceIdOf(device);
                string deviceName = FriendlyNameOf(device) ?? deviceId;

                Guid iid = IidAudioClient;
                object activated;
                device.Activate(ref iid, ClsCtxAll, IntPtr.Zero, out activated);
                client = (IAudioClient)activated;

                WaveFormatEx requested = new WaveFormatEx();
                requested.FormatTag = 1;
                requested.Channels = (ushort)options.Channels;
                requested.SamplesPerSec = (uint)options.Rate;
                requested.BitsPerSample = (ushort)options.Bits;
                requested.BlockAlign = (ushort)(options.Channels * options.Bits / 8);
                requested.AvgBytesPerSec = requested.SamplesPerSec * requested.BlockAlign;
                requested.CbSize = 0;

                int outputChannels = options.Channels;
                int outputRate = options.Rate;
                int outputBits = options.Bits;
                bool converted = false;

                IntPtr requestedPointer = AllocFormat(requested);
                try
                {
                    int flags = StreamFlagsLoopback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality;
                    int result = TryInitialize(client, flags, requestedPointer);
                    if (result == 0)
                    {
                        converted = true;
                    }
                    else
                    {
                        // Fall back to the engine mix format and convert in managed code.
                        IntPtr mixPointer;
                        int mixResult = TryMixFormat(client, out mixPointer);
                        if (mixResult != 0)
                            throw new InvalidOperationException("Initialize(0x" + result.ToString("X8", Inv) +
                                ") and GetMixFormat(0x" + mixResult.ToString("X8", Inv) + ") both failed");
                        WaveFormatEx mix = ReadFormat(mixPointer);
                        CaptureFormat form = ResolveFormat(mixPointer, mix);
                        int fallback = TryInitialize(client, StreamFlagsLoopback, form.RawPointer);
                        if (fallback != 0)
                            throw new InvalidOperationException("loopback Initialize failed: 0x" +
                                fallback.ToString("X8", Inv));
                        outputChannels = options.Channels;
                        outputRate = options.Rate;
                        outputBits = options.Bits;
                        sink = new WaveSink(options.Out, options.Stream, outputChannels, outputRate, outputBits, form);
                    }
                }
                finally
                {
                    Marshal.FreeHGlobal(requestedPointer);
                }

                object captureObject;
                Guid captureIid = IidAudioCaptureClient;
                client.GetService(ref captureIid, out captureObject);
                capture = (IAudioCaptureClient)captureObject;

                if (sink == null)
                    sink = new WaveSink(options.Out, options.Stream, outputChannels, outputRate, outputBits, null);

                LevelReporter reporter = new LevelReporter(outputRate, options.Levels);
                Emit("{\"event\":\"start\",\"device\":" + Json(deviceName) +
                    ",\"deviceId\":" + Json(deviceId) + ",\"rate\":" + outputRate.ToString(Inv) +
                    ",\"channels\":" + outputChannels.ToString(Inv) +
                    ",\"bits\":" + outputBits.ToString(Inv) +
                    ",\"converted\":" + (converted ? "true" : "false") +
                    ",\"file\":" + Json(options.Out) + "}");
                Stdout.Flush();

                client.Start();
                long startedTicks = DateTime.UtcNow.Ticks;
                long lastLoudTicks = startedTicks;
                long frames = 0;
                byte[] scratch = new byte[0];

                bool silentStop = false;
                bool stopped = false;

                while (!stopped)
                {
                    int packets = NextPacketSize(capture);
                    bool produced = false;
                    while (packets > 0)
                    {
                        IntPtr data;
                        int framesAvailable;
                        int bufferFlags;
                        long devicePosition;
                        long qpcPosition;
                        if (!TryGetBuffer(capture, out data, out framesAvailable, out bufferFlags,
                                          out devicePosition, out qpcPosition))
                            break;
                        try
                        {
                            if ((bufferFlags & BufferFlagsSilent) != 0 || framesAvailable == 0)
                            {
                                sink.WriteSilence(framesAvailable);
                                reporter.Accumulate(0d, framesAvailable);
                                frames += framesAvailable;
                            }
                            else
                            {
                                int bytesAvailable = framesAvailable * sink.InputBlockAlign;
                                if (scratch.Length < bytesAvailable)
                                    scratch = new byte[bytesAvailable];
                                Marshal.Copy(data, scratch, 0, bytesAvailable);
                                double rms = sink.WriteRaw(scratch, framesAvailable);
                                reporter.Accumulate(rms, sink.LastOutputFrames);
                                frames += sink.LastOutputFrames;
                            }
                            produced = true;
                        }
                        finally
                        {
                            capture.ReleaseBuffer(framesAvailable);
                        }
                        packets = NextPacketSize(capture);
                    }

                    if (produced)
                    {
                        if (reporter.LastRms >= options.SilenceThreshold)
                            lastLoudTicks = DateTime.UtcNow.Ticks;
                    }

                    // Keep the timeline honest while the endpoint is idle: loopback
                    // delivers no packets at all when nothing is playing.
                    sink.PadTo(ElapsedSeconds(startedTicks), reporter);
                    reporter.Sample(ElapsedSeconds(startedTicks));

                    double elapsed = ElapsedSeconds(startedTicks);
                    if (options.SilenceStopMs > 0 &&
                        elapsed >= options.SilenceGuardSeconds &&
                        (DateTime.UtcNow.Ticks - lastLoudTicks) / 10000L >= options.SilenceStopMs)
                    {
                        silentStop = true;
                        stopped = true;
                    }
                    if (elapsed >= options.Seconds)
                        stopped = true;
                    if (options.StopFile != null && File.Exists(options.StopFile))
                        stopped = true;
                    if (options.StopOnStdin && StdinClosed)
                        stopped = true;

                    if (!stopped)
                    {
                        Thread.Sleep(25);
                        continue;
                    }

                    // Drain whatever the engine still holds before stopping.
                    for (int round = 0; round < 4; round++)
                    {
                        if (NextPacketSize(capture) <= 0)
                            break;
                        Thread.Sleep(10);
                    }
                }

                client.Stop();
                sink.Finish();

                double totalSeconds = sink.Frames / (double)outputRate;
                Emit("{\"event\":\"done\",\"file\":" + Json(options.Out) +
                    ",\"seconds\":" + Format(totalSeconds) +
                    ",\"frames\":" + sink.Frames.ToString(Inv) +
                    ",\"bytes\":" + sink.DataBytes.ToString(Inv) +
                    ",\"rate\":" + outputRate.ToString(Inv) +
                    ",\"channels\":" + outputChannels.ToString(Inv) +
                    ",\"bits\":" + outputBits.ToString(Inv) +
                    ",\"rms\":" + Format(sink.TotalRms()) +
                    ",\"peak\":" + Format(sink.Peak) +
                    ",\"silentStop\":" + (silentStop ? "true" : "false") +
                    ",\"converted\":" + (converted ? "true" : "false") +
                    ",\"device\":" + Json(deviceName) + "}");
                Stdout.Flush();
            }
            finally
            {
                if (client != null)
                {
                    try
                    {
                        client.Stop();
                    }
                    catch (Exception)
                    {
                    }
                    Marshal.ReleaseComObject(client);
                }
                if (capture != null)
                    Marshal.ReleaseComObject(capture);
                if (sink != null)
                {
                    try
                    {
                        sink.Dispose();
                    }
                    catch (Exception)
                    {
                    }
                }
                Marshal.ReleaseComObject(device);
            }
        }

        private static double ElapsedSeconds(long startedTicks)
        {
            return (DateTime.UtcNow.Ticks - startedTicks) / 10000000d;
        }

        private static IntPtr AllocFormat(WaveFormatEx format)
        {
            IntPtr pointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(WaveFormatEx)));
            Marshal.StructureToPtr(format, pointer, false);
            return pointer;
        }

        private static WaveFormatEx ReadFormat(IntPtr pointer)
        {
            return (WaveFormatEx)Marshal.PtrToStructure(pointer, typeof(WaveFormatEx));
        }

        // COM interop is ambiguous about whether an `int`-returning method without
        // [PreserveSig] throws on a failed HRESULT or returns the code, so capture both.
        private static int TryInitialize(IAudioClient client, int flags, IntPtr format)
        {
            try
            {
                return client.Initialize(ShareModeShared, flags, 10L * 1000 * 1000, 0, format, IntPtr.Zero);
            }
            catch (COMException error)
            {
                return error.HResult;
            }
            catch (Exception error)
            {
                return error.HResult;
            }
        }

        private static int TryMixFormat(IAudioClient client, out IntPtr format)
        {
            try
            {
                int result = client.GetMixFormat(out format);
                if (result != 0)
                    format = IntPtr.Zero;
                return result;
            }
            catch (COMException error)
            {
                format = IntPtr.Zero;
                return error.HResult;
            }
            catch (Exception error)
            {
                format = IntPtr.Zero;
                return error.HResult;
            }
        }

        private static bool TryGetBuffer(IAudioCaptureClient capture, out IntPtr data, out int frames,
                                         out int flags, out long devicePosition, out long qpcPosition)
        {
            try
            {
                int result = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                return result == 0 && frames >= 0;
            }
            catch (Exception)
            {
                data = IntPtr.Zero;
                frames = 0;
                flags = 0;
                devicePosition = 0;
                qpcPosition = 0;
                return false;
            }
        }

        private static int NextPacketSize(IAudioCaptureClient capture)
        {
            try
            {
                int packets;
                capture.GetNextPacketSize(out packets);
                return packets;
            }
            catch (Exception)
            {
                return 0;
            }
        }

        private sealed class CaptureFormat
        {
            public IntPtr RawPointer;
            public ushort Tag;
            public int Channels;
            public int Rate;
            public int Bits;
            public int BlockAlign;
            public bool IsFloat;
        }

        private static CaptureFormat ResolveFormat(IntPtr pointer, WaveFormatEx format)
        {
            CaptureFormat result = new CaptureFormat();
            result.RawPointer = pointer;
            result.Tag = format.FormatTag;
            result.Channels = format.Channels;
            result.Rate = (int)format.SamplesPerSec;
            result.Bits = format.BitsPerSample;
            result.BlockAlign = format.BlockAlign;
            result.IsFloat = format.FormatTag == 3;
            if (format.FormatTag == 0xFFFE && format.CbSize >= 22)
            {
                // WAVE_FORMAT_EXTENSIBLE: the first two bytes of the sub-format GUID
                // carry the plain format tag.
                short subTag = Marshal.ReadInt16(pointer, 18 + 6);
                result.IsFloat = subTag == 3;
            }
            return result;
        }

        // ---- WAV writing / conversion -----------------------------------------
        private sealed class WaveSink : IDisposable
        {
            private readonly MemoryStream buffer;
            private readonly BinaryWriter writer;
            private readonly string path;
            private readonly bool streamMode;
            private readonly CaptureFormat input;
            private readonly int outputChannels;
            private readonly int outputRate;
            private readonly int outputBits;
            private double[] pending = new double[0];
            private long framesWritten;
            private long dataBytes;
            private double sumSquares;
            private double peak;
            private double position;
            private bool finished;

            public WaveSink(string path, bool streamMode, int channels, int rate, int bits, CaptureFormat input)
            {
                this.path = path;
                this.streamMode = streamMode;
                this.input = input;
                this.outputChannels = channels;
                this.outputRate = rate;
                this.outputBits = bits;
                // Samples are buffered in memory and handed over by Finish(): a
                // confined sandbox denies the spawned child any file write, and
                // stdout cannot be seeked back once the header sizes are known.
                buffer = new MemoryStream(2 * 1024 * 1024);
                writer = new BinaryWriter(buffer);
                WriteHeader(0);
            }

            public int InputChannels
            {
                get { return input == null ? 1 : input.Channels; }
            }

            public int InputBlockAlign
            {
                get { return input == null ? 2 : input.BlockAlign; }
            }

            public long Frames
            {
                get { return framesWritten; }
            }

            public long DataBytes
            {
                get { return dataBytes; }
            }

            public int LastOutputFrames { get; set; }

            public double Peak
            {
                get { return peak; }
            }

            public double TotalRms()
            {
                if (framesWritten == 0)
                    return 0d;
                double mean = sumSquares / framesWritten;
                return mean <= 0d ? 0d : Math.Sqrt(mean);
            }

            private void WriteHeader(long dataLength)
            {
                buffer.Position = 0;
                writer.Write(new char[] { 'R', 'I', 'F', 'F' });
                writer.Write((uint)(36 + dataLength));
                writer.Write(new char[] { 'W', 'A', 'V', 'E' });
                writer.Write(new char[] { 'f', 'm', 't', ' ' });
                writer.Write((uint)16);
                writer.Write((ushort)1);
                writer.Write((ushort)outputChannels);
                writer.Write((uint)outputRate);
                writer.Write((uint)(outputRate * outputChannels * outputBits / 8));
                writer.Write((ushort)(outputChannels * outputBits / 8));
                writer.Write((ushort)outputBits);
                writer.Write(new char[] { 'd', 'a', 't', 'a' });
                writer.Write((uint)dataLength);
                buffer.Position = buffer.Length;
            }

            public void WriteSilence(int frames)
            {
                if (frames <= 0)
                    return;
                int bytes = frames * outputChannels * outputBits / 8;
                writer.Write(new byte[bytes]);
                dataBytes += bytes;
                framesWritten += frames;
                LastOutputFrames = frames;
            }

            /// <summary>Append one capture packet, converting to the output format.</summary>
            public double WriteRaw(byte[] buffer, int frames)
            {
                double rms;
                if (input == null)
                {
                    // Engine already delivered exactly the requested format.
                    int bytes = frames * outputChannels * outputBits / 8;
                    writer.Write(buffer, 0, bytes);
                    dataBytes += bytes;
                    framesWritten += frames;
                    LastOutputFrames = frames;
                    rms = Measure(buffer, frames * outputChannels);
                    TrackSum(rms, frames);
                    return rms;
                }

                int channels = input.Channels;
                int count = frames * channels;
                double[] samples = new double[count];
                if (input.IsFloat && input.Bits == 32)
                {
                    float[] temp = new float[count];
                    Buffer.BlockCopy(buffer, 0, temp, 0, count * 4);
                    for (int index = 0; index < count; index++)
                        samples[index] = temp[index];
                }
                else
                {
                    for (int index = 0; index < count; index++)
                    {
                        short value = BitConverter.ToInt16(buffer, index * 2);
                        samples[index] = value / 32768d;
                    }
                }

                // Downmix to mono and resample with a box filter from inputRate to outputRate.
                double[] mono = new double[frames];
                for (int frame = 0; frame < frames; frame++)
                {
                    double accumulator = 0d;
                    for (int channel = 0; channel < channels; channel++)
                        accumulator += samples[frame * channels + channel];
                    mono[frame] = accumulator / channels;
                }

                int extra = pending.Length;
                int total = extra + frames;
                double[] joined = new double[total];
                Array.Copy(pending, 0, joined, 0, extra);
                Array.Copy(mono, 0, joined, extra, frames);

                double step = (double)input.Rate / outputRate;
                List<short> output = new List<short>(frames);
                double cursor = position;
                while (cursor < total - 1)
                {
                    int low = (int)Math.Floor(cursor - step / 2d);
                    int high = (int)Math.Ceiling(cursor + step / 2d);
                    if (low < 0)
                        low = 0;
                    if (high > total)
                        high = total;
                    if (high <= low)
                        high = low + 1;
                    double accumulator = 0d;
                    for (int index = low; index < high; index++)
                        accumulator += joined[index];
                    double value = accumulator / (high - low);
                    double clamped = value > 1d ? 1d : (value < -1d ? -1d : value);
                    output.Add((short)Math.Round(clamped * 32767d));
                    cursor += step;
                }
                position = cursor - total;

                int keep = total - (int)Math.Floor(cursor - step);
                if (keep < 0)
                    keep = 0;
                if (keep > total)
                    keep = total;
                pending = new double[keep];
                Array.Copy(joined, total - keep, pending, 0, keep);

                double outputSquares = 0d;
                byte[] pcmBytes = new byte[output.Count * 2];
                for (int index = 0; index < output.Count; index++)
                {
                    double value = output[index] / 32768d;
                    outputSquares += value * value;
                    if (Math.Abs(value) > peak)
                        peak = Math.Abs(value);
                    pcmBytes[index * 2] = (byte)(output[index] & 0xFF);
                    pcmBytes[index * 2 + 1] = (byte)((output[index] >> 8) & 0xFF);
                }
                writer.Write(pcmBytes);
                dataBytes += pcmBytes.Length;
                framesWritten += output.Count;
                LastOutputFrames = output.Count;
                double outputRms = output.Count == 0 ? 0d : Math.Sqrt(outputSquares / output.Count);
                TrackSum(outputRms, output.Count);
                return outputRms;
            }

            private void TrackSum(double rms, int frames)
            {
                sumSquares += rms * rms * frames;
                if (rms > peak)
                    peak = rms;
            }

            private static double Measure(byte[] buffer, int samples)
            {
                if (samples == 0)
                    return 0d;
                double sum = 0d;
                for (int index = 0; index < samples; index++)
                {
                    short value = BitConverter.ToInt16(buffer, index * 2);
                    double normalised = value / 32768d;
                    sum += normalised * normalised;
                }
                return Math.Sqrt(sum / samples);
            }

            /// <summary>Pad the timeline to the elapsed wall-clock position.</summary>
            public void PadTo(double elapsedSeconds, LevelReporter reporter)
            {
                if (framesWritten == 0)
                    return; // anchor the timeline at the first real packet
                long expected = (long)(elapsedSeconds * outputRate);
                if (expected <= framesWritten)
                    return;
                long missing = expected - framesWritten;
                if (missing > outputRate)
                    missing = outputRate;
                if (missing <= 2)
                    return;
                WriteSilence((int)missing);
                reporter.Accumulate(0d, (int)missing);
            }

            public void Finish()
            {
                if (finished)
                    return;
                finished = true;
                writer.Flush();
                WriteHeader(dataBytes);
                writer.Flush();
                byte[] bytes = buffer.ToArray();
                if (streamMode)
                {
                    // Hand the complete WAV to the parent process over the pipe.
                    Stdout.Write(bytes, 0, bytes.Length);
                    Stdout.Flush();
                    return;
                }
                string directory = Path.GetDirectoryName(Path.GetFullPath(path));
                if (!string.IsNullOrEmpty(directory))
                    Directory.CreateDirectory(directory);
                using (FileStream file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read))
                    file.Write(bytes, 0, bytes.Length);
            }

            public void Dispose()
            {
                try
                {
                    Finish();
                }
                catch (Exception)
                {
                }
                writer.Dispose();
                buffer.Dispose();
            }
        }

        // ---- level reporting --------------------------------------------------
        private sealed class LevelReporter
        {
            private readonly int rate;
            private readonly bool enabled;
            private readonly long startTicks;
            private long windowFrames;
            private double windowSquares;
            private long lastEmitTicks;
            private double accumulatedSeconds;

            public LevelReporter(int rate, bool enabled)
            {
                this.rate = rate;
                this.enabled = enabled;
                startTicks = DateTime.UtcNow.Ticks;
                lastEmitTicks = startTicks;
            }

            public double LastRms { get; private set; }

            public void Accumulate(double rms, int frames)
            {
                if (frames <= 0)
                    return;
                windowSquares += rms * rms * frames;
                windowFrames += frames;
                LastRms = rms;
                accumulatedSeconds += frames / (double)rate;
            }

            public void Sample(double elapsed)
            {
                if (!enabled)
                    return;
                long now = DateTime.UtcNow.Ticks;
                if (now - lastEmitTicks < 1000000L) // 100 ms
                    return;
                lastEmitTicks = now;
                double rms = windowFrames == 0 ? 0d : Math.Sqrt(windowSquares / windowFrames);
                windowSquares = 0d;
                windowFrames = 0;
                Emit("{\"event\":\"level\",\"t\":" + Format(elapsed) +
                    ",\"rms\":" + Format(rms) +
                    ",\"db\":" + Format(rms <= 0d ? -120d : 20d * Math.Log10(rms)) + "}");
                Stdout.Flush();
            }
        }

        // ---- header repair ----------------------------------------------------
        private static void RepairWave(string path)
        {
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
            {
                long length = stream.Length;
                long dataLength = length > 44 ? length - 44 : 0;
                stream.Position = 4;
                byte[] size = BitConverter.GetBytes((uint)(36 + dataLength));
                stream.Write(size, 0, 4);
                stream.Position = 40;
                byte[] data = BitConverter.GetBytes((uint)dataLength);
                stream.Write(data, 0, 4);
                stream.Flush(true);
                Emit("{\"event\":\"repaired\",\"file\":" + Json(path) +
                    ",\"bytes\":" + dataLength.ToString(Inv) + "}");
            }
        }

        // ---- options ----------------------------------------------------------
        private sealed class Options
        {
            public string Out;
            /// <summary>True when Out is "-": write the WAV to stdout instead of a file.</summary>
            public bool Stream;
            public string Repair;
            /// <summary>File name resolved inside this process's own temp directory when Out is absent.</summary>
            public string OutTemp;
            public string DeviceId;
            public string StopFile;
            /// <summary>Stop gracefully once stdin reaches end of file.</summary>
            public bool StopOnStdin;
            public double Seconds = 30d;
            public int Rate = 16000;
            public int Channels = 1;
            public int Bits = 16;
            public bool Levels;
            public bool ListDevices;
            public int SilenceStopMs;
            public double SilenceThreshold = 0.006d;
            public double SilenceGuardSeconds = 1d;

            public static Options Parse(string[] args)
            {
                Options options = new Options();
                for (int index = 0; index < args.Length; index++)
                {
                    string argument = args[index];
                    switch (argument)
                    {
                        case "--list-devices":
                            options.ListDevices = true;
                            break;
                        case "--levels":
                            options.Levels = true;
                            break;
                        case "--capture":
                            break;
                        case "--out":
                            options.Out = Next(args, ref index, argument);
                            break;
                        case "--repair":
                            options.Repair = Next(args, ref index, argument);
                            break;
                        case "--out-temp":
                            options.OutTemp = Next(args, ref index, argument);
                            break;
                        case "--stop-on-stdin":
                            options.StopOnStdin = true;
                            break;
                        case "--device":
                            options.DeviceId = Next(args, ref index, argument);
                            break;
                        case "--stop-file":
                            options.StopFile = Next(args, ref index, argument);
                            break;
                        case "--seconds":
                            options.Seconds = ParseDouble(Next(args, ref index, argument));
                            break;
                        case "--rate":
                            options.Rate = (int)ParseDouble(Next(args, ref index, argument));
                            break;
                        case "--channels":
                            options.Channels = (int)ParseDouble(Next(args, ref index, argument));
                            break;
                        case "--bits":
                            options.Bits = (int)ParseDouble(Next(args, ref index, argument));
                            break;
                        case "--silence-stop":
                            options.SilenceStopMs = (int)ParseDouble(Next(args, ref index, argument));
                            break;
                        case "--silence-threshold":
                            options.SilenceThreshold = ParseDouble(Next(args, ref index, argument));
                            break;
                        default:
                            throw new ArgumentException("unknown argument: " + argument);
                    }
                }
                if (options.Seconds <= 0d || options.Seconds > 3600d)
                    throw new ArgumentException("--seconds must be within (0, 3600]");
                if (options.Rate <= 0 || options.Rate > 192000)
                    throw new ArgumentException("--rate is out of range");
                if (options.Channels <= 0 || options.Channels > 2)
                    throw new ArgumentException("--channels is out of range");
                if (options.Bits != 16)
                    throw new ArgumentException("--bits must be 16");
                return options;
            }

            private static string Next(string[] args, ref int index, string name)
            {
                if (index + 1 >= args.Length)
                    throw new ArgumentException(name + " needs a value");
                index++;
                return args[index];
            }

            private static double ParseDouble(string text)
            {
                double value;
                if (!double.TryParse(text, NumberStyles.Float, Inv, out value))
                    throw new ArgumentException("not a number: " + text);
                return value;
            }
        }

        // ---- helpers ----------------------------------------------------------
        private static string Format(double value)
        {
            return value.ToString("0.######", Inv);
        }

        private static string Json(string value)
        {
            if (value == null)
                return "null";
            StringBuilder builder = new StringBuilder("\"");
            for (int index = 0; index < value.Length; index++)
            {
                char character = value[index];
                switch (character)
                {
                    case '"':
                        builder.Append("\\\"");
                        break;
                    case '\\':
                        builder.Append("\\\\");
                        break;
                    case '\n':
                        builder.Append("\\n");
                        break;
                    case '\r':
                        builder.Append("\\r");
                        break;
                    case '\t':
                        builder.Append("\\t");
                        break;
                    default:
                        if (character < ' ')
                            builder.Append("\\u").Append(((int)character).ToString("x4", Inv));
                        else
                            builder.Append(character);
                        break;
                }
            }
            builder.Append('"');
            return builder.ToString();
        }

        private static void EmitError(string message)
        {
            Emit("{\"event\":\"error\",\"message\":" + Json(message) + "}");
            Stdout.Flush();
        }
    }
}
