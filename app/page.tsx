 "use client";

import { useCallback, useEffect, useRef, useState } from "react";
import mqtt, { type MqttClient } from "mqtt";
import {
  Activity,
  ArrowUpRight,
  Bell,
  ChevronDown,
  CircleHelp,
  Clock3,
  Cpu,
  Droplets,
  Gauge,
  LayoutDashboard,
  Mic,
  MicOff,
  Volume2,
  Power,
  Radio,
  Settings,
  ShieldCheck,
  Sprout,
  Wifi,
  Zap,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type HistoryPoint = { time: string; moisture: number };
type SpeechRecognitionResultLike = ArrayLike<{ transcript: string }>;

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

const TOPICS = {
  control: "SmartIrr/status/pompa1",
  moisture: "SmartIrr/stat/pompa1",
  pumpStatus: "SmartIrr/Conn/Pompa1",
  modeStatus: "SmartIrr/status/mode1",
};

const mqttHost = process.env.NEXT_PUBLIC_MQTT_HOST;
const mqttPort = process.env.NEXT_PUBLIC_MQTT_PORT || "8084";
const mqttPath = process.env.NEXT_PUBLIC_MQTT_PATH || "/mqtt";
const mqttUsername = process.env.NEXT_PUBLIC_MQTT_USERNAME;
const mqttPassword = process.env.NEXT_PUBLIC_MQTT_PASSWORD;

function formatTime(date: Date) {
  return date.toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function parsePumpPayload(payload: string): boolean | null {
  const value = payload.trim().toUpperCase();
  if (["1", "ON", "TRUE"].includes(value)) return true;
  if (["0", "OFF", "FALSE"].includes(value)) return false;
  return null;
}

function parseMoisturePayload(payload: string): number | null {
  const trimmed = payload.trim();

  // Firmware saat ini mengirim angka biasa, misalnya "100".
  const directValue = Number(trimmed);
  if (trimmed !== "" && Number.isFinite(directValue)) {
    return Math.min(100, Math.max(0, directValue));
  }

  // Tetap mendukung JSON jika format firmware diubah di kemudian hari.
  try {
    const parsed = JSON.parse(trimmed);
    const candidate =
      parsed.moisture ?? parsed.soilMoisture ?? parsed.humidity ?? parsed.value;
    const value = Number(candidate);
    if (candidate !== undefined && Number.isFinite(value)) {
      return Math.min(100, Math.max(0, value));
    }
  } catch {
    // Payload bukan JSON; abaikan.
  }

  return null;
}

export default function Dashboard() {
  const clientRef = useRef<MqttClient | null>(null);

  const [mqttConnected, setMqttConnected] = useState(false);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [moisture, setMoisture] = useState<number | null>(null);
  const [rawADC] = useState<number | null>(null);
  const [pumpOn, setPumpOn] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"AUTO" | "MANUAL">("AUTO");
  const [modeSynced, setModeSynced] = useState(false);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [lastUpdate, setLastUpdate] = useState<string>("Belum ada data");
  const [lastTelemetryAt, setLastTelemetryAt] = useState<number | null>(null);
  const [mqttError, setMqttError] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);

  const [voiceMessage, setVoiceMessage] = useState(
    "Tekan tombol mikrofon lalu ucapkan perintah."
  );

  const [lastVoiceCommand, setLastVoiceCommand] = useState("");

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
    useEffect(() => {
    return () => {
      recognitionRef.current?.stop();

      if ("speechSynthesis" in window) {
        window.speechSynthesis.cancel();
      }
    };
  }, []);
  
  useEffect(() => {
    if (!mqttHost || !mqttUsername || !mqttPassword) {
      setMqttError(
        "Konfigurasi MQTT belum lengkap. Periksa variabel di .env.local."
      );
      return;
    }

    const brokerUrl = `wss://${mqttHost}:${mqttPort}${mqttPath}`;

    const client = mqtt.connect(brokerUrl, {
      username: mqttUsername,
      password: mqttPassword,
      clientId: `smart-irrigation-web-${Math.random()
        .toString(16)
        .slice(2, 10)}`,
      clean: true,
      connectTimeout: 10_000,
      reconnectPeriod: 3_000,
      keepalive: 30,
    });

    clientRef.current = client;

    client.on("connect", () => {
      setMqttConnected(true);
      setMqttError("");

      client.subscribe(
        [TOPICS.moisture, TOPICS.pumpStatus, TOPICS.modeStatus],
        { qos: 0 },
        (error) => {
          if (error) {
            setMqttError(`Gagal subscribe topic: ${error.message}`);
          }
        }
      );
    });

    client.on("reconnect", () => {
      setMqttConnected(false);
    });

    client.on("offline", () => {
      setMqttConnected(false);
    });

    client.on("close", () => {
      setMqttConnected(false);
    });

    client.on("error", (error) => {
      setMqttConnected(false);
      setMqttError(error.message || "Koneksi MQTT mengalami kesalahan.");
    });

    client.on("message", (topic, message) => {
      const payload = message.toString().trim();

      if (topic === TOPICS.moisture) {
        const nextMoisture = parseMoisturePayload(payload);

        if (nextMoisture !== null) {
          const now = new Date();

          setMoisture(nextMoisture);
          setLastTelemetryAt(Date.now());
          setDeviceOnline(true);
          setLastUpdate(formatTime(now));

          setHistory((current) =>
            [
              ...current,
              {
                time: formatTime(now),
                moisture: nextMoisture,
              },
            ].slice(-20)
          );
        }
      }

      if (topic === TOPICS.pumpStatus) {
        const nextPumpState = parsePumpPayload(payload);

        if (nextPumpState !== null) {
          setPumpOn(nextPumpState);
        }
      }

      if (topic === TOPICS.modeStatus) {
        const receivedMode = payload.toUpperCase();

        if (receivedMode === "AUTO" || receivedMode === "MANUAL") {
          setMode(receivedMode);
          setModeSynced(true);
        }
      }
    });

    return () => {
      client.end(true);
      clientRef.current = null;
    };
  }, []);

  // Firmware mengirim telemetry setiap 15 detik.
  // ESP32 dianggap aktif jika data moisture diterima dalam 45 detik terakhir.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (lastTelemetryAt === null) {
        setDeviceOnline(false);
        return;
      }

      const elapsed = Date.now() - lastTelemetryAt;

      setDeviceOnline(elapsed < 5_000);
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [lastTelemetryAt]);

  const publishCommand = useCallback((command: string) => {
    const client = clientRef.current;

    if (!client || !client.connected) {
      setMqttError("Website belum terhubung ke broker MQTT.");
      return false;
    }

    client.publish(TOPICS.control, command, { qos: 0, retain: false }, (err) => {
      if (err) setMqttError(`Perintah gagal dikirim: ${err.message}`);
    });

    return true;
  }, []);
  // Membacakan respons sistem
const speak = useCallback((message: string) => {
  if (!("speechSynthesis" in window)) return;

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(message);
  utterance.lang = "id-ID";
  utterance.rate = 1;

  window.speechSynthesis.speak(utterance);
}, []);


// Memproses perintah suara
const handleVoiceCommand = useCallback(
  (rawTranscript: string) => {
    const command = rawTranscript
      .toLowerCase()
      .replace(/[.,!?]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    setLastVoiceCommand(rawTranscript);

    const respond = (message: string) => {
      setVoiceMessage(message);
      speak(message);
    };

    // STATUS KELEMBAPAN
    if (
      command.includes("status kelembapan") ||
      command.includes("kelembapan tanah") || 
      command.includes("cek tanah") 
    ) {
      respond(
        moisture === null
          ? "Data kelembapan belum tersedia."
          : `Kelembapan tanah saat ini ${moisture} persen.`
      );
      return;
    }

    // STATUS POMPA
    if (
      command.includes("status pompa") ||
      command.includes("cek pompa")
    ) {
      const status =
        pumpOn === null
          ? "belum diketahui"
          : pumpOn
            ? "menyala"
            : "mati";

      respond(`Status pompa saat ini ${status}.`);
      return;
    }

    // MODE OTOMATIS
    if (
      command.includes("mode otomatis") ||
      command === "otomatis" ||
      command === "auto"
    ) {
      if (!mqttConnected) {
        respond("Koneksi MQTT belum tersedia.");
        return;
      }

      changeMode("AUTO");
      respond("Mode otomatis diaktifkan.");
      return;
    }

    // MODE MANUAL
    if (
      command.includes("mode manual") ||
      command === "manual"
    ) {
      if (!mqttConnected) {
        respond("Koneksi MQTT belum tersedia.");
        return;
      }

      changeMode("MANUAL");
      respond("Mode manual diaktifkan.");
      return;
    }

    // POMPA MATI
    if (
      command.includes("pompa mati") ||
      command.includes("matikan pompa") ||
      command.includes("pompa off")
    ) {
      if (!mqttConnected) {
        respond("Koneksi MQTT belum tersedia.");
        return;
      }

      if (publishCommand("MANUAL") && publishCommand("OFF")) {
        setMode("MANUAL");
        respond("Perintah pompa mati telah dikirim.");
      } else {
        respond("Gagal mengirim perintah.");
      }

      return;
    }

    // POMPA MENYALA
    if (
      command.includes("pompa nyala") ||
      command.includes("pompa hidup") ||
      command.includes("nyalakan pompa") ||
      command.includes("hidupkan pompa") ||
      command.includes("pompa on")
    ) {
      if (!mqttConnected) {
        respond("Koneksi MQTT belum tersedia.");
        return;
      }

      if (publishCommand("MANUAL") && publishCommand("ON")) {
        setMode("MANUAL");
        respond("Perintah pompa menyala telah dikirim.");
      } else {
        respond("Gagal mengirim perintah.");
      }

      return;
    }

    respond(
      "Perintah tidak dikenali. Silakan ulangi."
    );
  },
  [moisture, pumpOn, mqttConnected, publishCommand, speak]
);

const toggleVoiceRecognition = useCallback(() => {
  if (voiceListening) {
    recognitionRef.current?.stop();
    setVoiceListening(false);
    setVoiceMessage("Pengenalan suara dihentikan.");
    return;
  }

  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };

  const SpeechRecognitionAPI =
    speechWindow.SpeechRecognition ||
    speechWindow.webkitSpeechRecognition;

  if (!SpeechRecognitionAPI) {
    setVoiceMessage(
      "Browser tidak mendukung pengenalan suara. Gunakan Chrome atau Edge."
    );
    return;
  }

  const recognition = new SpeechRecognitionAPI();

  recognition.lang = "id-ID";
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    const transcript =
      event.results[0]?.[0]?.transcript ?? "";

    handleVoiceCommand(transcript);
  };

  recognition.onerror = (event) => {
    if (event.error === "not-allowed") {
      setVoiceMessage(
        "Izin mikrofon ditolak. Aktifkan izin mikrofon."
      );
    } else {
      setVoiceMessage(
        `Pengenalan suara gagal: ${event.error}`
      );
    }
  };

  recognition.onend = () => {
    setVoiceListening(false);
  };

  recognitionRef.current = recognition;

  try {
    recognition.start();

    setVoiceListening(true);

    setVoiceMessage(
      "Mendengarkan... silakan ucapkan perintah."
    );
  } catch {
    setVoiceListening(false);
    setVoiceMessage("Mikrofon gagal dimulai.");
  }
}, [voiceListening, handleVoiceCommand]);

  const changeMode = (newMode: "AUTO" | "MANUAL") => {
    if (publishCommand(newMode)) {
      setMode(newMode);
      setMqttError("");
    }
  };

  const togglePump = () => {
    if (mode !== "MANUAL") return;

    const command = pumpOn ? "OFF" : "ON";
    if (publishCommand(command)) {
      setMqttError("");
    }
  };

  return (
    <main className="min-h-screen bg-[#F1F4F8] text-slate-800">
      {/* SIDEBAR */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[250px] flex-col border-r border-[#26364B] bg-[#101C2D] text-white lg:flex">
        <div className="flex h-[82px] items-center gap-3 border-b border-white/10 px-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-500">
            <Sprout size={23} className="text-white" />
          </div>
          <div>
            <h1 className="text-[15px] font-bold tracking-wide">
              SMART IRRIGATION
            </h1>
            <p className="mt-1 text-[10px] tracking-[2px] text-slate-400">
              CONTROL SYSTEM
            </p>
          </div>
        </div>

        <div className="px-5 pt-8">
          <p className="mb-3 px-3 text-[10px] font-bold tracking-[2px] text-slate-500">
            MAIN MENU
          </p>
          <nav className="space-y-1">
            <SidebarItem icon={<LayoutDashboard size={18} />} label="Dashboard" active />
            <SidebarItem icon={<Activity size={18} />} label="Monitoring" />
            <SidebarItem icon={<Power size={18} />} label="Pump Control" />
            <SidebarItem icon={<Cpu size={18} />} label="Devices" />
          </nav>

          <p className="mb-3 mt-9 px-3 text-[10px] font-bold tracking-[2px] text-slate-500">
            SYSTEM
          </p>
          <nav className="space-y-1">
            <SidebarItem icon={<Settings size={18} />} label="Configuration" />
            <SidebarItem icon={<CircleHelp size={18} />} label="Help Center" />
          </nav>
        </div>

        <div className="mt-auto p-5">
          <div className="rounded-xl border border-white/10 bg-[#1A2A40] p-4">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${mqttConnected ? "bg-emerald-400" : "bg-amber-400"}`} />
              <p className="text-xs font-semibold text-slate-200">
                {mqttConnected ? "Live MQTT Mode" : "Connecting MQTT"}
              </p>
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
              {mqttConnected
                ? "Dashboard menerima data dari broker EMQX."
                : "Menunggu koneksi ke broker EMQX Cloud."}
            </p>
          </div>
          <p className="mt-5 text-center text-[10px] text-slate-600">
            SMART IRRIGATION © 2026
          </p>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <div className="min-h-screen lg:ml-[250px]">
        {/* TOPBAR */}
        <header className="sticky top-0 z-20 flex h-[76px] items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur md:px-8">
          <div>
            <p className="text-[11px] font-medium text-slate-400">
              AGRICULTURE / IOT PLATFORM
            </p>
            <p className="mt-1 text-sm font-bold text-slate-700">
              Irrigation Management
            </p>
          </div>

          <div className="flex items-center gap-3 md:gap-5">
            <div className={`hidden items-center gap-2 rounded-lg border px-3 py-2 sm:flex ${mqttConnected ? "border-emerald-200 bg-emerald-50" : "border-amber-200 bg-amber-50"}`}>
              <span className={`h-2 w-2 rounded-full ${mqttConnected ? "bg-emerald-500" : "bg-amber-500"}`} />
              <span className={`text-[11px] font-semibold ${mqttConnected ? "text-emerald-700" : "text-amber-700"}`}>
                {mqttConnected ? "MQTT CONNECTED" : "MQTT OFFLINE"}
              </span>
            </div>
            <button className="relative rounded-lg border border-slate-200 p-2.5 text-slate-500 hover:bg-slate-50">
              <Bell size={18} />
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-blue-500" />
            </button>
            <div className="hidden items-center gap-2 border-l border-slate-200 pl-4 sm:flex">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-sm font-bold text-blue-700">
                IR
              </div>
              <div>
                <p className="text-xs font-bold">Administrator</p>
                <p className="text-[10px] text-slate-400">System Manager</p>
              </div>
              <ChevronDown size={14} className="text-slate-400" />
            </div>
          </div>
        </header>

        <div className="p-5 md:p-8">
          {/* PAGE TITLE */}
          <section className="mb-7 flex flex-wrap items-end justify-between gap-4">
            <div>
              <div className="mb-2 flex items-center gap-2 text-xs text-slate-400">
                <span>Dashboard</span><span>/</span>
                <span className="font-medium text-blue-600">Overview</span>
              </div>
              <h2 className="text-2xl font-bold tracking-tight text-[#17263A] md:text-[28px]">
                System Overview
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Monitor soil conditions and manage your irrigation system.
              </p>
            </div>
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
              <Clock3 size={15} />
              Last update: {lastUpdate}
            </div>
          </section>

          {mqttError && (
            <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
              {mqttError}
            </div>
          )}

          {/* DEVICE STATUS */}
          <section className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-600">
                <Cpu size={21} />
              </div>
              <div>
                <p className="text-xs text-slate-400">Active Device</p>
                <p className="mt-1 text-sm font-bold text-slate-800">ESP32-001</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-5">
              <div className="flex items-center gap-2">
                <Wifi size={16} className={deviceOnline ? "text-emerald-500" : "text-slate-400"} />
                <span className="text-xs font-medium text-slate-500">
                  {deviceOnline ? "ESP32 Online" : "ESP32 Offline"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Radio size={16} className={mqttConnected ? "text-emerald-500" : "text-slate-400"} />
                <span className="text-xs font-medium text-slate-500">
                  {mqttConnected ? "EMQX Connected" : "MQTT Offline"}
                </span>
              </div>
            </div>
          </section>

          {/* METRIC CARDS */}
          <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              title="SOIL MOISTURE"
              value={moisture === null ? "--" : `${moisture}%`}
              description="Live sensor reading"
              icon={<Droplets size={21} />}
              color="blue"
              trend={moisture === null ? "WAITING" : "LIVE DATA"}
            />
            <MetricCard
              title="RAW SENSOR VALUE"
              value={rawADC === null ? "--" : rawADC.toLocaleString("en-US")}
              description="Analog input / GPIO 32"
              icon={<Gauge size={21} />}
              color="purple"
              trend="NOT PUBLISHED"
            />
            <MetricCard
              title="PUMP STATUS"
              value={pumpOn === null ? "--" : pumpOn ? "ON" : "OFF"}
              description="Water pump 01"
              icon={<Power size={21} />}
              color="green"
              trend={pumpOn === null ? "NO STATUS" : pumpOn ? "ACTIVE" : "STANDBY"}
            />
            <MetricCard
              title="OPERATING MODE"
              value={mode}
              description="Irrigation controller"
              icon={<Settings size={21} />}
              color="orange"
              trend={modeSynced ? "DEVICE CONFIRMED" : "WAITING SYNC"}
            />
          </section>

          {/* ANALYTICS + CONTROL */}
          <section className="mt-6 grid grid-cols-1 gap-5 xl:grid-cols-3">
            {/* CHART */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 xl:col-span-2 md:p-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">Soil Moisture Analytics</h3>
                  <p className="mt-1 text-xs text-slate-400">Live readings from ESP32 via MQTT</p>
                </div>
                <div className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-medium text-slate-600">
                  <Radio size={14} /> Real-time
                </div>
              </div>

              <div className="mt-7 h-[280px] w-full">
                {history.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={history} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                      <defs>
                        <linearGradient id="blueGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#2878E5" stopOpacity={0.25} />
                          <stop offset="95%" stopColor="#2878E5" stopOpacity={0.01} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="#E9EEF5" strokeDasharray="4 4" vertical={false} />
                      <XAxis dataKey="time" tick={{ fill: "#94A3B8", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                      <YAxis domain={[0, 100]} tick={{ fill: "#94A3B8", fontSize: 11 }} axisLine={false} tickLine={false} ticks={[0, 20, 40, 60, 80, 100]} />
                      <Tooltip contentStyle={{ borderRadius: "10px", border: "1px solid #E2E8F0", fontSize: "12px" }} formatter={(value) => [`${value}%`, "Moisture"]} />
                      <Area type="monotone" dataKey="moisture" stroke="#2878E5" strokeWidth={3} fill="url(#blueGradient)" activeDot={{ r: 5, fill: "#2878E5" }} />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-slate-200 text-center">
                    <div>
                      <Activity className="mx-auto mb-2 text-slate-300" size={28} />
                      <p className="text-sm font-semibold text-slate-500">Waiting for sensor data</p>
                      <p className="mt-1 text-xs text-slate-400">Data akan muncul setelah ESP32 publish ke topic MQTT.</p>
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
                <div className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-blue-500" />
                  <span className="text-xs text-slate-500">Soil moisture (%)</span>
                </div>
                <p className="text-[11px] text-slate-400">
                  {history.length} live samples received
                </p>
              </div>
            </div>

            {/* PUMP CONTROL */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 md:p-6">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold text-slate-800">Pump Controller</h3>
                  <p className="mt-1 text-xs text-slate-400">Irrigation actuator</p>
                </div>
                <div className="rounded-lg bg-blue-50 p-2 text-blue-600"><Power size={20} /></div>
              </div>

              <div className="my-6 rounded-xl border border-slate-100 bg-[#F7F9FC] px-4 py-7 text-center">
                <div className={`mx-auto flex h-[82px] w-[82px] items-center justify-center rounded-full border-[7px] ${pumpOn ? "border-blue-100 bg-blue-50 text-blue-600" : "border-slate-200 bg-slate-100 text-slate-400"}`}>
                  <Droplets size={34} />
                </div>
                <h4 className="mt-4 text-2xl font-bold text-slate-800">
                  {pumpOn === null ? "NO DATA" : pumpOn ? "PUMP ON" : "PUMP OFF"}
                </h4>
                <p className="mt-1 text-xs text-slate-400">
                  {pumpOn === null ? "Menunggu status dari ESP32" : pumpOn ? "Pump is active" : "Pump is in standby"}
                </p>
                <div className="mt-4 flex justify-center">
                  <span className={`rounded-full px-3 py-1 text-[10px] font-bold ${pumpOn ? "bg-blue-100 text-blue-700" : "bg-slate-200 text-slate-600"}`}>
                    {pumpOn === null ? "--" : pumpOn ? "ACTIVE" : "INACTIVE"}
                  </span>
                </div>
              </div>

              <p className="mb-2 text-xs font-bold text-slate-600">OPERATING MODE</p>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => changeMode("AUTO")}
                  disabled={!mqttConnected}
                  className={`rounded-lg py-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${mode === "AUTO" ? "bg-blue-600 text-white shadow-sm shadow-blue-200" : "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                >
                  AUTO MODE
                </button>
                <button
                  onClick={() => changeMode("MANUAL")}
                  disabled={!mqttConnected}
                  className={`rounded-lg py-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-40 ${mode === "MANUAL" ? "bg-blue-600 text-white shadow-sm shadow-blue-200" : "border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"}`}
                >
                  MANUAL
                </button>
              </div>

              <button
                onClick={togglePump}
                disabled={!mqttConnected || mode !== "MANUAL"}
                className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg py-3 text-xs font-bold transition disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 ${mode === "MANUAL" && mqttConnected ? pumpOn ? "bg-red-500 text-white hover:bg-red-600" : "bg-[#17263A] text-white hover:bg-slate-700" : ""}`}
              >
                <Power size={16} />
                {pumpOn ? "TURN OFF PUMP" : "TURN ON PUMP"}
              </button>

              <p className="mt-3 text-center text-[10px] leading-relaxed text-slate-400">
               {!modeSynced
                  ? "Menunggu konfirmasi mode dari ESP32."
                  : mode === "AUTO"
                    ? "Mode otomatis aktif pada controller ESP32."
                    : "Mode manual aktif pada controller ESP32."}
              </p>
            </div>
          </section>

          
{/* VOICE CONTROL */}
<section className="mt-6 rounded-xl border border-slate-200 bg-white p-5 md:p-6">

  <div className="flex items-center justify-between gap-3">
    <div className="flex items-center gap-3">
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
        <Mic size={22} />
      </div>

      <div>
        <h3 className="text-sm font-bold text-slate-800">
          Voice Control
        </h3>
        <p className="mt-1 text-xs text-slate-400">
          Kendali irigasi menggunakan perintah suara
        </p>
      </div>
    </div>

    <span className={`rounded-full px-3 py-1.5 text-[10px] font-bold ${
      voiceListening
        ? "bg-emerald-100 text-emerald-700"
        : "bg-slate-100 text-slate-500"
    }`}>
      {voiceListening ? "LISTENING" : "STANDBY"}
    </span>
  </div>

  <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-[auto_1fr]">

    <button
      onClick={toggleVoiceRecognition}
      className={`flex items-center justify-center gap-2 rounded-xl px-6 py-4 text-sm font-bold text-white transition ${
        voiceListening
          ? "bg-red-500 hover:bg-red-600"
          : "bg-blue-600 hover:bg-blue-700"
      }`}
    >
      {voiceListening ? (
        <MicOff size={19} />
      ) : (
        <Mic size={19} />
      )}

      {voiceListening
        ? "STOP LISTENING"
        : "START VOICE CONTROL"}
    </button>

    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">

      <div className="flex items-center gap-2">
        <Volume2 size={15} className="text-blue-600" />

        <p className="text-xs font-semibold text-slate-700">
          Respons Sistem
        </p>
      </div>

      <p className="mt-2 text-xs leading-relaxed text-slate-600">
        {voiceMessage}
      </p>

      {lastVoiceCommand && (
        <p className="mt-2 text-[10px] text-slate-400">
          Perintah terakhir: "{lastVoiceCommand}"
        </p>
      )}

    </div>
  </div>

  <div className="mt-5 border-t border-slate-100 pt-4">

    <p className="mb-3 text-[10px] font-bold tracking-wider text-slate-400">
      CONTOH PERINTAH SUARA
    </p>

    <div className="flex flex-wrap gap-2">
      {[
        "Pompa nyala",
        "Pompa mati",
        "Mode otomatis",
        "Mode manual",
        "Status pompa",
        "cek tanah"
      ].map((item) => (
        <span
          key={item}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] font-medium text-slate-600"
        >
          "{item}"
        </span>
      ))}
    </div>

  </div>

  <p className="mt-4 text-[10px] leading-relaxed text-slate-400">
    Gunakan Chrome atau Edge dengan izin mikrofon aktif.
    Perintah pompa dikirim melalui MQTT.
  </p>

</section>


          {/* LOWER INFORMATION */}
          <section className="mt-6 grid grid-cols-1 gap-5 lg:grid-cols-2">
            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-800">Sensor Information</h3>
                <ShieldCheck size={18} className="text-blue-500" />
              </div>
              <div className="mt-5 space-y-4">
                <DetailRow label="Sensor Name" value="Soil Moisture Sensor 01" />
                <DetailRow label="GPIO Pin" value="GPIO 32" />
                <DetailRow label="Raw ADC" value={rawADC === null ? "Belum dikirim ESP32" : rawADC.toLocaleString("en-US")} />
                <DetailRow label="Moisture" value={moisture === null ? "Menunggu data" : `${moisture}%`} />
                <DetailRow label="Data Source" value="EMQX MQTT" />
              </div>
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-5">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-800">System Information</h3>
                <Zap size={18} className="text-blue-500" />
              </div>
              <div className="mt-5 space-y-4">
                <DetailRow label="Device" value="ESP32-001" />
                <DetailRow label="Connection Status" value={deviceOnline ? "Online" : "Offline"} status={deviceOnline ? "online" : "offline"} />
                <DetailRow label="MQTT Broker" value={mqttConnected ? "EMQX Connected" : "Disconnected"} />
                <DetailRow label="Firmware" value="MQTT telemetry" />
                <DetailRow label="Operating Mode" value={mode} />
              </div>
            </div>
          </section>

          <footer className="mt-8 flex flex-wrap justify-between gap-2 border-t border-slate-200 pt-5 text-[10px] text-slate-400">
            <p>Smart Irrigation Management System</p>
            <p>Dashboard v1.1 · MQTT Live</p>
          </footer>
        </div>
      </div>
    </main>
  );
}

function SidebarItem({
  icon,
  label,
  active = false,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div className={`flex cursor-pointer items-center gap-3 rounded-lg px-3 py-3 text-[13px] font-medium transition ${active ? "bg-blue-600 text-white shadow-lg shadow-blue-950/20" : "text-slate-400 hover:bg-white/5 hover:text-white"}`}>
      {icon}
      {label}
    </div>
  );
}

function MetricCard({
  title,
  value,
  description,
  icon,
  color,
  trend,
}: {
  title: string;
  value: string;
  description: string;
  icon: React.ReactNode;
  color: string;
  trend: string;
}) {
  const styles: Record<string, string> = {
    blue: "bg-blue-50 text-blue-600",
    purple: "bg-violet-50 text-violet-600",
    green: "bg-emerald-50 text-emerald-600",
    orange: "bg-amber-50 text-amber-600",
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-[10px] font-bold tracking-[1.2px] text-slate-400">{title}</p>
          <h3 className="mt-4 text-[29px] font-bold tracking-tight text-[#17263A]">{value}</h3>
        </div>
        <div className={`rounded-xl p-3 ${styles[color]}`}>{icon}</div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
        <p className="text-[10px] text-slate-400">{description}</p>
        <span className="flex items-center gap-1 text-[10px] font-bold text-slate-400">{trend}</span>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  value,
  status,
}: {
  label: string;
  value: string;
  status?: "offline" | "online";
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-3 last:border-0 last:pb-0">
      <span className="text-xs text-slate-400">{label}</span>
      {status ? (
        <span className="flex items-center gap-2 text-xs font-semibold text-slate-500">
          <span className={`h-2 w-2 rounded-full ${status === "online" ? "bg-emerald-500" : "bg-slate-400"}`} />
          {value}
        </span>
      ) : (
        <span className="text-right text-xs font-semibold text-slate-700">{value}</span>
      )}
    </div>
  );
}
