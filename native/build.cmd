@echo off
rem Rebuild the WASAPI loopback recorder with the .NET Framework compiler that
rem ships with Windows (no SDK, no NuGet, no network).
setlocal
set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo build.cmd: csc.exe not found at "%CSC%"
  exit /b 1
)
"%CSC%" -nologo -optimize+ -target:exe -platform:x64 -out:"%~dp0LoopbackRecorder.exe" "%~dp0LoopbackRecorder.cs"
if errorlevel 1 (
  echo build.cmd: compile failed
  exit /b 1
)
echo build.cmd: wrote "%~dp0LoopbackRecorder.exe"
endlocal
