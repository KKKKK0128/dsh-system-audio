// dsh-system-audio — browser half.
//
// Hand-written in the client module format DSH expects: the file only registers
// a factory, and the module body runs when the shell materializes it. It needs
// nothing from the shell beyond React and the plugin context, so there is no
// build step and no generated Typert artifact — all privileged work (WASAPI
// capture, speech model, files) stays in the host half behind /system-audio.
window.__ModuleLoader__.load({
	id: "dsh-system-audio",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const h = React.createElement;

		const NS = "dsh-system-audio";
		const PREFIX = "/system-audio";
		const POLL_MS = 150;
		const MAX_SECONDS = 120;
		const SILENCE_MS = 1500;
		const HOTKEY = { key: "y", ctrl: true, shift: true };

		const strings = {
			zh: {
				start: "录制电脑声音并转成文字",
				stop: "停止录制并转写",
				recording: "正在录制电脑播放的声音",
				transcribing: "正在转写…",
				empty: "没有识别到语音",
				failed: "系统声音转写失败",
				busy: "正在录制中",
				copy: "复制文本",
				copied: "已复制",
				manual: "文本已生成，请手动插入草稿",
				options: "录制设置",
				device: "播放设备",
				deviceDefault: "默认设备",
				silence: "静音自动停止",
				refresh: "刷新设备",
				hotkey: "快捷键 Ctrl+Shift+Y",
			},
			en: {
				start: "Record computer audio and turn it into text",
				stop: "Stop recording and transcribe",
				recording: "Recording what the computer is playing",
				transcribing: "Transcribing…",
				empty: "No speech recognized",
				failed: "System audio transcription failed",
				busy: "Recording is active",
				copy: "Copy text",
				copied: "Copied",
				manual: "Text ready — insert it into the draft manually",
				options: "Capture settings",
				device: "Playback device",
				deviceDefault: "Default device",
				silence: "Stop after silence",
				refresh: "Refresh devices",
				hotkey: "Shortcut: Ctrl+Shift+Y",
			},
		};

		const css = `
.dsh-system-audio { display: inline-flex; align-items: center; gap: 6px; }
.dsh-system-audio__button {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 8px; border-radius: 8px; cursor: pointer;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
  background: transparent; color: inherit; font: inherit; font-size: 12px; line-height: 1;
}
.dsh-system-audio__button:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.dsh-system-audio__button[disabled] { opacity: 0.5; cursor: default; }
.dsh-system-audio__button--recording { border-color: #e5484d; color: #e5484d; }
.dsh-system-audio__button--icon { justify-content: center; min-width: 28px; padding: 0 6px; font-size: 13px; }
.dsh-system-audio__dot { width: 8px; height: 8px; border-radius: 50%; background: #e5484d; animation: dsh-system-audio-pulse 1s ease-in-out infinite; }
@keyframes dsh-system-audio-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
.dsh-system-audio__levels { display: flex; align-items: flex-end; gap: 2px; height: 16px; }
.dsh-system-audio__bar { width: 3px; min-height: 2px; border-radius: 1px; background: currentColor; opacity: 0.65; }
.dsh-system-audio__hint { font-size: 12px; opacity: 0.75; white-space: nowrap; }
.dsh-system-audio__hint--timer { font-variant-numeric: tabular-nums; }
.dsh-system-audio__panel {
  display: flex; flex-direction: column; gap: 6px; margin-top: 6px; padding: 8px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 8px;
  font-size: 12px; max-width: 420px;
}
.dsh-system-audio__panel textarea {
  width: 100%; min-height: 48px; resize: vertical; font: inherit; color: inherit;
  background: transparent; border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: 6px; padding: 6px;
}
.dsh-system-audio__error { color: #e5484d; }
.dsh-system-audio__options { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; flex-wrap: wrap; }
.dsh-system-audio__options select {
  font: inherit; color: inherit; background: transparent; max-width: 220px;
  border: 1px solid color-mix(in srgb, currentColor 22%, transparent); border-radius: 6px; padding: 2px 4px;
}
.dsh-system-audio__options label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.dsh-system-audio__hint--dim { opacity: 0.55; }
`;

		function label(t, key) {
			if (typeof t === "function") {
				try {
					const value = t(key);
					if (typeof value === "string" && value !== "" && value !== key) return value;
				} catch {
					/* fall through to the local dictionary */
				}
			}
			return strings.en[key] ?? key;
		}

		async function call(path, body) {
			const init = body === undefined
				? { method: "GET", headers: { accept: "application/json" } }
				: {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify(body),
				};
			const response = await fetch(PREFIX + path, { ...init, cache: "no-store" });
			const text = await response.text();
			let payload = null;
			if (text !== "") {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = null;
				}
			}
			if (!response.ok || payload === null || payload.ok !== true) {
				const message = payload && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
				throw new Error(message);
			}
			return payload;
		}

		function insertIntoDraft(inputActions, text) {
			if (text === "" || !inputActions || typeof inputActions.insertText !== "function") return false;
			try {
				const span = typeof inputActions.captureInsertion === "function" ? inputActions.captureInsertion() : undefined;
				return inputActions.insertText(text, span) !== false;
			} catch {
				return false;
			}
		}

		function SystemAudioActivity(props) {
			const t = props?.t;
			const inputActions = props?.inputActions;
			const locked = props?.locked === true;
			const onActiveChange = props?.onActiveChange;
			const [phase, setPhase] = React.useState("idle");
			const [levels, setLevels] = React.useState([]);
			const [elapsed, setElapsed] = React.useState(0);
			const [error, setError] = React.useState("");
			const [text, setText] = React.useState("");
			const [manual, setManual] = React.useState(false);
			const [note, setNote] = React.useState("");
			const [devices, setDevices] = React.useState([]);
			const [device, setDevice] = React.useState("");
			const [silence, setSilence] = React.useState(false);
			const [showOptions, setShowOptions] = React.useState(false);
			const idRef = React.useRef(null);
			const busyRef = React.useRef(false);

			const announce = React.useCallback((active) => {
				if (typeof onActiveChange === "function") {
					try {
						onActiveChange(active);
					} catch {
						/* the host slot may not use this hook */
					}
				}
			}, [onActiveChange]);

			React.useEffect(() => () => {
				const id = idRef.current;
				if (id !== null) void call(`/cancel?id=${encodeURIComponent(id)}`).catch(() => {});
			}, []);

			const loadDevices = React.useCallback(async () => {
				try {
					const payload = await call("/devices");
					const list = Array.isArray(payload.devices) ? payload.devices : [];
					setDevices(list);
					setDevice((current) => (list.some((item) => item?.id === current) ? current : ""));
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				}
			}, []);

			const start = React.useCallback(async () => {
				busyRef.current = true;
				setError("");
				setNote("");
				setText("");
				setManual(false);
				setPhase("starting");
				try {
					const started = await call("/start", {
						seconds: MAX_SECONDS,
						device: device === "" ? undefined : device,
						silenceMs: silence ? SILENCE_MS : undefined,
					});
					idRef.current = started.id;
					setLevels([]);
					setElapsed(0);
					setPhase("recording");
					announce(true);
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
					setPhase("idle");
				} finally {
					busyRef.current = false;
				}
			}, [announce, device, silence]);

			const finish = React.useCallback(async (id) => {
				busyRef.current = true;
				setPhase("stopping");
				setLevels([]);
				announce(false);
				try {
					const result = await call("/stop", { id });
					if (idRef.current === id) idRef.current = null;
					const value = typeof result.text === "string" ? result.text : "";
					setText(value);
					if (value === "") {
						setNote(label(t, "empty"));
					} else if (insertIntoDraft(inputActions, value)) {
						setNote("");
					} else {
						setManual(true);
						setNote(label(t, "manual"));
					}
					setPhase("idle");
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
					setPhase("idle");
				} finally {
					busyRef.current = false;
				}
			}, [announce, inputActions, t]);

			// While a capture runs, poll the host for the live level and the
			// elapsed time; the host stops on its own when `--seconds` expires.
			React.useEffect(() => {
				if (phase !== "recording") return undefined;
				let stopped = false;
				const tick = async () => {
					const id = idRef.current;
					if (id === null || stopped) return;
					try {
						const status = await call(`/status?id=${encodeURIComponent(id)}`);
						if (stopped) return;
						setLevels((status.levels ?? []).map((sample) => Math.min(1, Math.max(0, sample.rms * 8))));
						setElapsed(typeof status.elapsed === "number" ? status.elapsed : 0);
						if (status.state === "stopped" && !busyRef.current) {
							stopped = true;
							void finish(id);
						}
					} catch (failure) {
						if (!stopped) {
							stopped = true;
							setError(failure instanceof Error ? failure.message : String(failure));
							setPhase("idle");
						}
					}
				};
				const timer = setInterval(() => void tick(), POLL_MS);
				void tick();
				return () => {
					stopped = true;
					clearInterval(timer);
				};
			}, [phase, finish]);

			const toggle = React.useCallback(() => {
				if (busyRef.current || locked) return;
				if (phase === "recording") {
					const id = idRef.current;
					if (id !== null) void finish(id);
					return;
				}
				void start();
			}, [finish, locked, phase, start]);

			// In-app shortcut (the client half cannot register a system-wide one).
			React.useEffect(() => {
				if (typeof document?.addEventListener !== "function") return undefined;
				const onKeyDown = (event) => {
					if (event?.defaultPrevented) return;
					if (event?.ctrlKey !== true || event?.shiftKey !== true) return;
					if (event?.altKey === true || event?.metaKey === true) return;
					if (typeof event?.key !== "string" || event.key.toLowerCase() !== HOTKEY.key) return;
					if (typeof event.preventDefault === "function") event.preventDefault();
					toggle();
				};
				document.addEventListener("keydown", onKeyDown);
				return () => document.removeEventListener("keydown", onKeyDown);
			}, [toggle]);

			const copy = React.useCallback(async () => {
				try {
					await navigator.clipboard.writeText(text);
					setNote(label(t, "copied"));
				} catch {
					setNote(label(t, "manual"));
				}
			}, [t, text]);

			const recording = phase === "recording";
			const pending = phase === "starting" || phase === "stopping";
			const bars = levels.length === 0 ? [0] : levels.slice(-24);
			// Icon-only toggle: the wording lives in the tooltip and the aria
			// label so the composer row stays compact.
			const toggleTitle = label(t, recording ? "stop" : "start");
			const children = [
				h("button", {
					key: "button",
					type: "button",
					className: "dsh-system-audio__button dsh-system-audio__button--icon"
						+ (recording ? " dsh-system-audio__button--recording" : ""),
					disabled: locked || pending,
					title: toggleTitle,
					"aria-label": toggleTitle,
					onClick: toggle,
				}, recording
					? h("span", { key: "dot", className: "dsh-system-audio__dot" })
					: h("span", { key: "icon", "aria-hidden": "true" }, "🔊")),
			];
			if (recording) {
				children.push(h("span", {
					key: "timer",
					className: "dsh-system-audio__hint dsh-system-audio__hint--timer",
				}, `${Math.floor(elapsed)}s`));
				children.push(h("span", {
					key: "levels",
					className: "dsh-system-audio__levels",
					"aria-hidden": "true",
				}, bars.map((value, index) => h("span", {
					key: index,
					className: "dsh-system-audio__bar",
					style: { height: `${Math.max(2, Math.round(value * 16))}px` },
				}))));
			}
			if (pending) children.push(h("span", { key: "pending", className: "dsh-system-audio__hint" }, label(t, "transcribing")));
			if (note !== "") children.push(h("span", { key: "note", className: "dsh-system-audio__hint" }, note));
			children.push(h("button", {
				key: "options",
				type: "button",
				className: "dsh-system-audio__button",
				title: label(t, "options"),
				disabled: recording || pending || locked,
				onClick: () => setShowOptions((open) => {
					if (!open && devices.length === 0) void loadDevices();
					return !open;
				}),
			}, "⚙"));

			const wrapper = [h("span", { key: "row", className: "dsh-system-audio" }, children)];
			if (showOptions && !recording) {
				wrapper.push(h("div", { key: "options-panel", className: "dsh-system-audio__options" }, [
					h("span", { key: "device-label", className: "dsh-system-audio__hint" }, label(t, "device")),
					h("select", {
						key: "device",
						value: device,
						onChange: (event) => setDevice(typeof event?.target?.value === "string" ? event.target.value : ""),
					}, [
						h("option", { key: "auto", value: "" }, label(t, "deviceDefault")),
					].concat(devices.map((item) => h("option", {
						key: String(item?.id ?? ""),
						value: String(item?.id ?? ""),
					}, (item?.default === true ? "★ " : "") + String(item?.name ?? item?.id ?? ""))))),
					h("label", { key: "silence" }, [
						h("input", {
							key: "box",
							type: "checkbox",
							checked: silence,
							onChange: (event) => setSilence(event?.target?.checked === true),
						}),
						h("span", { key: "text" }, label(t, "silence")),
					]),
					h("button", {
						key: "refresh",
						type: "button",
						className: "dsh-system-audio__button",
						onClick: () => void loadDevices(),
					}, label(t, "refresh")),
					h("span", { key: "hotkey", className: "dsh-system-audio__hint dsh-system-audio__hint--dim" }, label(t, "hotkey")),
				]));
			}
			if (error !== "" || manual) {
				wrapper.push(h("div", { key: "panel", className: "dsh-system-audio__panel" }, [
					error !== ""
						? h("span", { key: "error", className: "dsh-system-audio__error" }, label(t, "failed") + ": " + error)
						: null,
					manual && text !== ""
						? h("textarea", { key: "text", readOnly: true, value: text })
						: null,
					manual && text !== ""
						? h("button", { key: "copy", type: "button", className: "dsh-system-audio__button", onClick: () => void copy() }, label(t, "copy"))
						: null,
				].filter((child) => child !== null)));
			}
			return h(React.Fragment, null, wrapper);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			ctx.effect(() => {
				if (typeof ctx.locale?.register === "function") return ctx.locale.register(NS, strings);
				return undefined;
			});
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-dsh-system-audio", "");
				style.textContent = css;
				document.head.appendChild(style);
				return () => style.remove();
			});
			// The composer-row recorder button that used to be registered here
			// (slot `conversation.input.left`, id `dsh-system-audio`) was removed on
			// request: the microphone/record control no longer lives in the input
			// box. The capture flow itself is unchanged — it moved to the
			// dsh-interview-mode sidebar panel ("录一段并识别"), which drives the same
			// /system-audio/start|status|stop routes. SystemAudioActivity and its CSS
			// are kept in place so the control can be re-registered without a rewrite.
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
