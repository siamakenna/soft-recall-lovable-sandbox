import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import bedroomImg from "@/assets/scene-bedroom.jpg";
import phoneImg from "@/assets/scene-phone.jpg";
import hallwayImg from "@/assets/scene-hallway.jpg";
import kitchenImg from "@/assets/scene-kitchen.jpg";
import bathroomImg from "@/assets/scene-bathroom.jpg";
import {
  playChime, playDissonant, playSoftClick, playPageTurn,
  playBreathIn, playBreathOut,
  startAmbient, stopAmbient, setMuted as audioSetMuted, setVolume as audioSetVolume,
} from "./audio";


/* ------------------------------------------------------------------ */
/* Types & data                                                        */
/* ------------------------------------------------------------------ */

type RoomId = "bedroom" | "hallway" | "kitchen" | "bathroom";
type SceneId = RoomId | "phone" | "frontdoor";
type EndingId = "supported" | "hurried" | "withdrawn";

interface Hotspot {
  id: string;
  label: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  onInspect: () => void;
}

interface MemoryEntry {
  section: "Fragments" | "Messages" | "Routines" | "Reflections";
  title: string;
  body: string;
}

interface Settings {
  reducedMotion: boolean;
  grain: number;
  fuzzCap: number;
  markerScale: number;   // 0.5 – 1.5, affects marker visual + hit-area
  debugHotspots: boolean; // toggle with `~`
  foliage: number;       // 0 – 1 Ghibli greenery overlay strength
  muted: boolean;
  volume: number;        // 0 – 1
  subtitleScale: number; // 0.85 – 1.6
  dyslexiaFont: boolean;
  parallax: boolean;
}

interface VNLine { speaker: string; text: string; }
interface VNChoice { id: string; label: string; onPick: () => void; tone?: "neutral" | "wrong" | "kind"; }

const SAVE_KEY = "soft-recall.save.v4";
const SETTINGS_KEY = "soft-recall.settings.v3";
const HOTSPOT_OVERRIDES_KEY = "soft-recall.hotspots.v1";
const ONBOARD_KEY = "soft-recall.onboarded.v1";
const DEFAULT_SETTINGS: Settings = {
  reducedMotion: false, grain: 0.5, fuzzCap: 1, markerScale: 1.15,
  debugHotspots: false, foliage: 0.8,
  muted: false, volume: 0.6, subtitleScale: 1, dyslexiaFont: false, parallax: true,
};
/* Total number of hotspot-tasks in the game — drives the progressive clarity curve. */
const TOTAL_TASKS = 13;

/* Second-visit thoughts — surface on hover of an already-inspected hotspot */
const REVISIT_THOUGHTS: Record<string, string[]> = {
  glasses: ["The frames are warm now.", "You could clean them, but not today."],
  note:    ["The handwriting looks less scared today.", "One step. Then the next."],
  alarm:   ["The lamp is patient.", "It has waited longer than this."],
  curtains:["The light is a shade less grey.", "The room agrees to be seen."],
  phone:   ["The screen is dim again. Good."],
  coat:    ["It remembers the shape of your arm."],
  keys:    ["Two, still. That's enough."],
  mail:    ["It'll wait. It always waits."],
  "k-fridge": ["Sunday-you did well."],
  "k-kettle": ["Steam still, faintly."],
  "k-toast":  ["Crumbs. Small evidence of a morning."],
  "b-mirror": ["Hello again."],
  "b-meds":   ["The little compartment is empty and honest."],
  "b-tap":    ["The basin holds a trace of cold."],
  "b-teeth":  ["Mint, faint."],
};

type HotspotOverrides = Record<string, Record<string, { x: number; y: number }>>;
// shape: { [sceneId]: { [hotspotId]: {x,y} } }

const SCENE_IMG: Record<SceneId, string> = {
  bedroom: bedroomImg,
  hallway: hallwayImg,
  kitchen: kitchenImg,
  bathroom: bathroomImg,
  phone: phoneImg,
  frontdoor: hallwayImg,
};

const ROOM_LABEL: Record<RoomId, string> = {
  bedroom: "Bedroom",
  hallway: "Hallway",
  kitchen: "Kitchen",
  bathroom: "Bathroom",
};

const ADJACENCY: Record<RoomId, RoomId[]> = {
  bedroom:  ["hallway"],
  hallway:  ["bedroom", "kitchen", "bathroom"],
  kitchen:  ["hallway"],
  bathroom: ["hallway"],
};

/* Sub-tasks required per routine (doubles the interaction density) */
const KITCHEN_TASKS = ["k-kettle", "k-fridge", "k-toast"] as const;
const BATH_TASKS    = ["b-mirror", "b-meds", "b-tap", "b-teeth"] as const;
const KITCHEN_MIN = 2;
const BATH_MIN = 2;

/* ------------------------------ mini-games ------------------------- */
type MiniKind = "brush" | "sip" | "knob" | "splash" | "pour";
interface MiniSpec {
  kind: MiniKind;
  title: string;
  hint: string;
  onDone: () => void;
  onCancel?: () => void;
}

/* ------------------------------------------------------------------ */
/* Root component                                                      */
/* ------------------------------------------------------------------ */

export default function SoftRecall() {
  const [screen, setScreen] = useState<"title" | "game" | "ending">("title");
  const [room, setRoom] = useState<RoomId>("bedroom");
  const [closeup, setCloseup] = useState<null | "phone">(null);
  const [visited, setVisited] = useState<Set<RoomId>>(new Set(["bedroom"]));
  const [unlocked, setUnlocked] = useState<Set<RoomId>>(new Set(["bedroom"]));
  const [frontDoorUnlocked, setFrontDoorUnlocked] = useState(false);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [memory, setMemory] = useState<MemoryEntry[]>([]);
  const [vnLine, setVnLine] = useState<VNLine | null>(null);
  const [vnChoices, setVnChoices] = useState<VNChoice[]>([]);
  const [showBook, setShowBook] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [ending, setEnding] = useState<EndingId | null>(null);
  const [hasSave, setHasSave] = useState(false);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [hintPulse, setHintPulse] = useState(false);
  const [tutorialActive, setTutorialActive] = useState(false);
  const [wrongCount, setWrongCount] = useState(0);
  const [toast, setToast] = useState<{ section: string; title: string; id: number } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const saveTimer = useRef<number | null>(null);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const [hotspotOverrides, setHotspotOverrides] = useState<HotspotOverrides>({});
  const [dragging, setDragging] = useState<{ scene: string; id: string } | null>(null);
  const [mini, setMini] = useState<MiniSpec | null>(null);
  const startMini = useCallback((spec: MiniSpec) => setMini(spec), []);
  /* New: clarity/dissonance, onboarding, hint cooldown, breathe ritual, parallax, hover thought */
  const [clarity, setClarity] = useState(0);
  const [dissonance, setDissonance] = useState(0);
  const [onboarded, setOnboarded] = useState(true);
  const [hintCooldown, setHintCooldown] = useState(0);
  const [breathing, setBreathing] = useState<null | "in" | "out">(null);
  const [thought, setThought] = useState<{ id: string; text: string } | null>(null);
  const parallaxRef = useRef({ x: 0, y: 0 });
  const [parallax, setParallax] = useState({ x: 0, y: 0 });
  const rafParallax = useRef<number | null>(null);
  /* Hold-mouse-and-drag to actively pan the scene perspective */
  const [dragPan, setDragPan] = useState({ x: 0, y: 0 });
  const dragPanRef = useRef({ active: false, startX: 0, startY: 0, baseX: 0, baseY: 0 });


  /* ---------------------- persistence ----------------------------- */
  useEffect(() => {
    try {
      const s = localStorage.getItem(SETTINGS_KEY);
      if (s) setSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(s) });
      setHasSave(!!localStorage.getItem(SAVE_KEY));
      const o = localStorage.getItem(HOTSPOT_OVERRIDES_KEY);
      if (o) setHotspotOverrides(JSON.parse(o));
      setOnboarded(!!localStorage.getItem(ONBOARD_KEY));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
    audioSetMuted(settings.muted);
    audioSetVolume(settings.volume);
  }, [settings]);
  useEffect(() => {
    try { localStorage.setItem(HOTSPOT_OVERRIDES_KEY, JSON.stringify(hotspotOverrides)); } catch {}
  }, [hotspotOverrides]);
  /* Debounced save — fixes stutter from writing on every state change */
  useEffect(() => {
    if (screen !== "game") return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          room, visited: [...visited], unlocked: [...unlocked],
          frontDoorUnlocked, done: [...done], memory, wrongCount, clarity, dissonance,
        }));
        setHasSave(true);
      } catch {}
    }, 400);
    return () => { if (saveTimer.current) window.clearTimeout(saveTimer.current); };
  }, [screen, room, visited, unlocked, frontDoorUnlocked, done, memory, wrongCount, clarity, dissonance]);

  /* Ambient bed per scene */
  useEffect(() => {
    if (screen !== "game" || settings.muted) { stopAmbient(); return; }
    startAmbient(closeup ?? room);
    return () => { /* keep running across renders */ };
  }, [screen, room, closeup, settings.muted]);
  useEffect(() => () => stopAmbient(), []);

  const remember = useCallback((entry: MemoryEntry) => {
    setMemory((prev) => {
      if (prev.some(e => e.title === entry.title)) return prev;
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
      setToast({ section: entry.section, title: entry.title, id: Date.now() });
      toastTimer.current = window.setTimeout(() => setToast(null), 2800);
      playChime();
      setClarity(c => c + 1);
      return [...prev, entry];
    });
  }, []);

  const say = useCallback((speaker: string, text: string) => {
    setVnLine({ speaker, text });
    setVnChoices([]);
    playSoftClick();
  }, []);

  const markDone = useCallback((id: string) => {
    setDone(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev); next.add(id); return next;
    });
  }, []);

  const misstep = useCallback((line?: { speaker: string; text: string }) => {
    setWrongCount(w => Math.min(6, w + 1));
    setDissonance(d => d + 1);
    playDissonant();
    if (line) setVnLine(line);
  }, []);

  const gotoRoom = useCallback((r: RoomId) => {
    setCloseup(null);
    setRoom(r);
    setVisited(prev => {
      if (prev.has(r)) return prev;
      const n = new Set(prev); n.add(r); return n;
    });
    setVnLine({ speaker: ROOM_LABEL[r], text: roomEnterLine(r) });
    setVnChoices([]);
    playPageTurn();
  }, []);


  /* ---------------------- start / load ---------------------------- */
  const beginNew = () => {
    setRoom("bedroom");
    setVisited(new Set(["bedroom"]));
    setUnlocked(new Set(["bedroom"]));
    setFrontDoorUnlocked(false);
    setDone(new Set());
    setMemory([]);
    setEnding(null);
    setCloseup(null);
    setWrongCount(0);
    setClarity(0);
    setDissonance(0);
    setVnLine({ speaker: "Morning", text: "The room is still deciding what shape to be." });
    setVnChoices([]);
    setTutorialActive(true);
    setScreen("game");
  };
  const continueSave = () => {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) { beginNew(); return; }
      const s = JSON.parse(raw);
      setRoom(s.room ?? "bedroom");
      setVisited(new Set(s.visited ?? ["bedroom"]));
      setUnlocked(new Set(s.unlocked ?? ["bedroom"]));
      setFrontDoorUnlocked(!!s.frontDoorUnlocked);
      setDone(new Set(s.done ?? []));
      setMemory(s.memory ?? []);
      setWrongCount(s.wrongCount ?? 0);
      setClarity(s.clarity ?? 0);
      setDissonance(s.dissonance ?? 0);
      setEnding(null);
      setCloseup(null);
      setTutorialActive(false);
      setVnLine({ speaker: ROOM_LABEL[(s.room ?? "bedroom") as RoomId], text: "You pick up where you left off." });
      setVnChoices([]);
      setScreen("game");
    } catch { beginNew(); }
  };
  const restartDemo = () => {
    try { localStorage.removeItem(SAVE_KEY); } catch {}
    setHasSave(false);
    beginNew();
  };
  const finishOnboarding = () => {
    try { localStorage.setItem(ONBOARD_KEY, "1"); } catch {}
    setOnboarded(true);
  };


  /* ---------------------- helpers --------------------------------- */

  const kitchenCount = useMemo(() => KITCHEN_TASKS.filter(t => done.has(t)).length, [done]);
  const bathCount    = useMemo(() => BATH_TASKS.filter(t => done.has(t)).length, [done]);

  const maybeUnlockFrontDoor = useCallback(() => {
    setDone(current => {
      const kOk = KITCHEN_TASKS.filter(t => current.has(t)).length >= KITCHEN_MIN;
      const bOk = BATH_TASKS.filter(t => current.has(t)).length >= BATH_MIN;
      if (kOk && bOk && !frontDoorUnlocked) {
        setFrontDoorUnlocked(true);
        setTimeout(() => {
          setVnLine({ speaker: "Front Door", text: "Warm. Clean. Ready. The door will open when you turn to it." });
        }, 900);
      }
      return current;
    });
  }, [frontDoorUnlocked]);

  /* ---------------------- bedroom interactions -------------------- */

  const inspectGlasses = () => {
    markDone("glasses");
    remember({ section: "Fragments", title: "Glasses on the sill", body: "Cold arms. Fingerprints. The world snaps into edges." });
    say("Glasses", "The room sharpens at the edges first.");
  };
  const inspectNote = () => {
    markDone("note");
    remember({ section: "Messages", title: "Note by the bed", body: "\"One step. Then the next.\" — your own handwriting, from some earlier morning." });
    say("Note", "One step. Then the next.");
  };
  const inspectAlarm = () => {
    markDone("alarm");
    remember({ section: "Fragments", title: "Alarm clock", body: "7:12. Later than you meant. Not late enough to panic." });
    say("Alarm", "7:12. Not a disaster. A margin, still.");
  };
  const inspectCurtains = () => {
    markDone("curtains");
    remember({ section: "Reflections", title: "Curtains, opened", body: "The room agrees to be seen. Grey light, but honest." });
    say("Curtains", "Light. Grey and honest.");
  };
  const openPhone = () => {
    setCloseup("phone");
    setVnLine({ speaker: "Phone", text: "The screen wakes. A message is half-typed, from you to someone who is waiting." });
    setVnChoices([
      { id: "send",   label: "Send: \"I'm slow this morning. On my way.\"",   onPick: phoneSend, tone: "kind" },
      { id: "later",  label: "Put the phone down for now.",                    onPick: phoneLater, tone: "neutral" },
      { id: "ignore", label: "Delete it. She'll figure it out.",               onPick: phoneIgnore, tone: "wrong" },
    ]);
  };
  const phoneSend = () => {
    markDone("phone");
    remember({ section: "Messages", title: "Sent to Ana", body: "\"I'm slow this morning. On my way.\" — delivered." });
    unlockHallwayFromPhone("The sentence is still hard, but the morning has heard you.");
  };
  const phoneLater = () => {
    markDone("phone");
    remember({ section: "Reflections", title: "Put it down", body: "The message can wait a minute longer. The morning still moved." });
    unlockHallwayFromPhone("You set it down. The hallway is waiting.");
  };
  const phoneIgnore = () => {
    markDone("phone");
    misstep({ speaker: "Phone", text: "Deleted. The room dims a shade. Something small tilts out of place." });
    setWrongCount(w => Math.min(6, w + 1));
    setTimeout(() => unlockHallwayFromPhone("You leave the room without answering. The hallway feels further than it is."), 1200);
  };
  const unlockHallwayFromPhone = (line: string) => {
    setUnlocked(prev => {
      const n = new Set(prev);
      n.add("hallway"); n.add("kitchen"); n.add("bathroom");
      return n;
    });
    setCloseup(null);
    setVnLine({ speaker: "Morning", text: line });
    setVnChoices([
      { id: "hall", label: "Step into the Hallway.", onPick: () => gotoRoom("hallway") },
      { id: "stay", label: "Stay in the bedroom a moment.", onPick: () => say("Bedroom", "The light shifts a little. You can leave when you're ready.") },
    ]);
  };

  /* ---------------------- hallway interactions -------------------- */

  const inspectCoat = () => {
    markDone("coat");
    remember({ section: "Fragments", title: "Coat on the hook", body: "The sleeve remembers the shape of an arm." });
    say("Coat", "It's where it always is. That helps.");
  };
  const inspectKeys = () => {
    markDone("keys");
    remember({ section: "Routines", title: "Keys, checked", body: "Two on the ring. The heavier one is home." });
    say("Keys", "You weigh them once. Both there.");
  };
  const inspectMail = () => {
    markDone("mail");
    remember({ section: "Fragments", title: "Yesterday's post", body: "A bill, a flyer, a card in handwriting you almost place." });
    say("Post", "Nothing urgent. Nothing to open now.");
  };
  const inspectFrontDoor = () => {
    if (!frontDoorUnlocked) {
      say("Front Door", "Not yet — you'd walk out empty. Warm something in the kitchen and wash up in the bathroom first.");
      return;
    }
    setVnLine({ speaker: "Front Door", text: "Keys. Coat. Phone. The list is short today, and complete." });
    setVnChoices([
      {
        id: "go",
        label: "Turn the knob and open the door.",
        tone: "kind",
        onPick: () => {
          setVnChoices([]);
          startMini({
            kind: "knob",
            title: "Open the door",
            hint: "Press and hold, then turn the knob a full quarter.",
            onDone: () => { setMini(null); resolveEnding(); },
            onCancel: () => { setMini(null); say("Front Door", "Your hand slips off. Try again when you're ready."); },
          });
        },
      },
      {
        id: "rush",
        label: "Yank it open. You're late already.",
        tone: "wrong",
        onPick: () => { misstep(); setWrongCount(w=>w+1); setTimeout(() => resolveEnding(), 700); },
      },
      { id: "wait", label: "Wait a moment longer.", onPick: () => say("Hallway", "The door isn't going anywhere.") },
    ]);
  };

  /* ---------------------- kitchen interactions -------------------- */

  const inspectFridge = () => {
    markDone("k-fridge");
    remember({ section: "Routines", title: "Fridge, opened", body: "Milk, half a lemon, a note from a version of you that shopped on Sunday." });
    say("Fridge", "Something to eat. Something to hold.");
    maybeUnlockFrontDoor();
  };
  const inspectKettle = () => {
    say("Kettle", "Steam rising. Pour, then sip until the cup is warm in your hand.");
    startMini({
      kind: "sip",
      title: "Drink your tea",
      hint: "Hold to sip. Keep holding until the cup empties.",
      onDone: () => {
        setMini(null);
        markDone("k-kettle");
        remember({ section: "Routines", title: "Tea, sipped slowly", body: "Steam. A small warm sound. The cup empties by degrees and the morning behaves." });
        say("Tea", "Warm. Held. A minute the morning couldn't take.");
        maybeUnlockFrontDoor();
      },
      onCancel: () => { setMini(null); say("Kettle", "You put the cup down half-full. That's fine too."); },
    });
  };
  const inspectToast = () => {
    markDone("k-toast");
    remember({ section: "Routines", title: "Toast, buttered", body: "Two slices. The knife knows the jar." });
    say("Toast", "Bread. Butter. A small pleasure that keeps.");
    maybeUnlockFrontDoor();
  };

  /* ---------------------- bathroom interactions ------------------- */

  const inspectMirror = () => {
    markDone("b-mirror");
    remember({ section: "Reflections", title: "The face in the mirror", body: "Warm brown hair. Cream sleep shirt. Eyes that recognise you back, even on the mornings you don't." });
    say("Mirror", "There you are. Hello. Good morning, you.");
    maybeUnlockFrontDoor();
  };
  const inspectMeds = () => {
    markDone("b-meds");
    remember({ section: "Routines", title: "Morning pills", body: "Thursday. The little compartment is empty by the time you close the lid." });
    say("Cabinet", "Thursday. Done.");
    maybeUnlockFrontDoor();
  };
  const inspectTap = () => {
    say("Tap", "Cold water in the basin. Splash — twice, three times.");
    startMini({
      kind: "splash",
      title: "Wash your face",
      hint: "Tap the water where it lands. Four handfuls.",
      onDone: () => {
        setMini(null);
        markDone("b-tap");
        remember({ section: "Routines", title: "Cold water", body: "Two handfuls on the face. The day starts here, if it starts anywhere." });
        say("Tap", "Cold. Then colder. Awake, mostly.");
        maybeUnlockFrontDoor();
      },
      onCancel: () => { setMini(null); say("Tap", "You leave the tap running a beat, then close it."); },
    });
  };
  const inspectTeeth = () => {
    say("Toothbrush", "Bristles, mint. Left side, then right — a small rhythm.");
    startMini({
      kind: "brush",
      title: "Brush your teeth",
      hint: "Alternate ← and → (or tap the arrows). Eight strokes.",
      onDone: () => {
        setMini(null);
        markDone("b-teeth");
        remember({ section: "Routines", title: "Teeth, brushed", body: "Left, right, left. The mint stays on your tongue for a while after." });
        say("Toothbrush", "Rinse. Spit. The mouth remembers itself.");
        maybeUnlockFrontDoor();
      },
      onCancel: () => { setMini(null); say("Toothbrush", "Half a job. Enough for now."); },
    });
  };


  /* ---------------------- ending resolution ----------------------- */

  const resolveEnding = () => {
    // Endings weighted by clarity vs dissonance
    const score = clarity - dissonance * 2;
    let id: EndingId = "supported";
    if (wrongCount >= 3 || score < 0) id = "hurried";
    else if (memory.length <= 5 || score < 3) id = "withdrawn";
    setEnding(id);
    setScreen("ending");
  };


  /* ---------------------- hotspots per scene ---------------------- */

  const sceneKey: string = closeup ?? room;

  const hotspots: Hotspot[] = useMemo(() => {
    let base: Hotspot[];
    if (closeup === "phone") {
      base = [
        { id: "phone-screen", label: "Phone screen", x: 50, y: 50, w: 32, h: 46, onInspect: () => {} },
      ];
    } else {
      switch (room) {
        case "bedroom":
          base = [
            { id: "curtains", label: "Window & curtains", x: 36, y: 28, onInspect: inspectCurtains },
            { id: "glasses",  label: "Glasses on the sill", x: 48, y: 56, onInspect: inspectGlasses },
            { id: "alarm",    label: "Bedside lamp", x: 92, y: 55, onInspect: inspectAlarm },
            { id: "note",     label: "Note on the bed", x: 62, y: 78, onInspect: inspectNote },
            { id: "phone",    label: "Phone on the nightstand", x: 92, y: 70, onInspect: openPhone },
          ]; break;
        case "hallway":
          base = [
            { id: "coat",      label: "Coat on the hook", x: 90, y: 22, onInspect: inspectCoat },
            { id: "keys",      label: "Keys on the hook", x: 87, y: 32, onInspect: inspectKeys },
            { id: "mail",      label: "Bowl on the side table", x: 14, y: 72, onInspect: inspectMail },
            { id: "frontdoor", label: frontDoorUnlocked ? "Front Door" : "Front Door (not yet)", x: 63, y: 46, onInspect: inspectFrontDoor },
          ]; break;
        case "kitchen":
          base = [
            { id: "k-fridge", label: "Shelves & pantry",  x: 40, y: 34, onInspect: inspectFridge },
            { id: "k-kettle", label: "Kettle on the stove",  x: 15, y: 55, onInspect: inspectKettle },
            { id: "k-toast",  label: "Cutting board", x: 78, y: 68, onInspect: inspectToast },
          ]; break;
        case "bathroom":
          base = [
            { id: "b-tap",    label: "Tap",              x: 60, y: 60, onInspect: inspectTap },
            { id: "b-mirror", label: "You, in the mirror", x: 56, y: 22, onInspect: inspectMirror },
            { id: "b-meds",   label: "Shelf jar & bottle", x: 27, y: 28, onInspect: inspectMeds },
            { id: "b-teeth",  label: "Toothbrush by the basin", x: 55, y: 50, onInspect: inspectTeeth },
          ]; break;
        default: base = [];
      }
    }
    const ov = hotspotOverrides[sceneKey] ?? {};
    return base.map(h => ov[h.id] ? { ...h, x: ov[h.id].x, y: ov[h.id].y } : h);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, closeup, frontDoorUnlocked, hotspotOverrides, sceneKey]);

  const availableExits: RoomId[] = useMemo(
    () => ADJACENCY[room].filter(r => unlocked.has(r)),
    [room, unlocked]
  );

  /* ---------------------- keyboard controls ----------------------- */

  const [focusIdx, setFocusIdx] = useState(0);
  useEffect(() => { setFocusIdx(0); }, [room, closeup]);

  /* Hint cooldown timer */
  useEffect(() => {
    if (hintCooldown <= 0) return;
    const t = window.setInterval(() => setHintCooldown(c => Math.max(0, c - 1)), 1000);
    return () => window.clearInterval(t);
  }, [hintCooldown]);

  /* Suggest a target for the next task (used by 'N' key) */
  const nextTaskId = useMemo(() => {
    if (room === "bedroom" && !done.has("phone")) return "phone";
    if (room === "hallway" && frontDoorUnlocked) return "frontdoor";
    if (room === "kitchen") return KITCHEN_TASKS.find(t => !done.has(t));
    if (room === "bathroom") return BATH_TASKS.find(t => !done.has(t));
    return undefined;
  }, [room, done, frontDoorUnlocked]);

  const requestHint = useCallback(() => {
    if (hintCooldown > 0) {
      setVnLine({ speaker: "Hint", text: `A breath — try again in ${hintCooldown}s.` });
      return;
    }
    setHintPulse(true);
    setHintCooldown(15);
    window.setTimeout(() => setHintPulse(false), 4000);
    const target = nextTaskId ?? (availableExits[0] ? `→ ${ROOM_LABEL[availableExits[0]]}` : "look around");
    setVnLine({ speaker: "Hint", text: `Try: ${target}.` });
  }, [hintCooldown, nextTaskId, availableExits]);

  /* Breathe ritual — hold 'B' to inhale/exhale; each full cycle removes 1 wrongCount/dissonance */
  useEffect(() => {
    if (screen !== "game") return;
    let downAt = 0;
    let phase: "in" | "out" | null = null;
    let raf = 0;
    const cycle = () => {
      if (!phase) return;
      const elapsed = performance.now() - downAt;
      if (phase === "in" && elapsed >= 3600) {
        phase = "out"; downAt = performance.now(); setBreathing("out"); playBreathOut();
      } else if (phase === "out" && elapsed >= 3600) {
        setWrongCount(w => Math.max(0, w - 1));
        setDissonance(d => Math.max(0, d - 1));
        phase = "in"; downAt = performance.now(); setBreathing("in"); playBreathIn();
      }
      raf = requestAnimationFrame(cycle);
    };
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b" || phase) return;
      if (showHelp || showBook || showSettings || mini) return;
      phase = "in"; downAt = performance.now(); setBreathing("in"); playBreathIn();
      raf = requestAnimationFrame(cycle);
    };
    const up = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "b") return;
      phase = null; setBreathing(null); cancelAnimationFrame(raf);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      cancelAnimationFrame(raf);
    };
  }, [screen, showHelp, showBook, showSettings, mini]);

  /* Parallax — track mouse over the scene, rAF-throttled. Hold + drag to actively pan. */
  useEffect(() => {
    if (!settings.parallax || settings.reducedMotion || screen !== "game") return;
    const el = sceneRef.current;
    if (!el) return;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      parallaxRef.current = {
        x: ((e.clientX - r.left) / r.width - 0.5) * 2,
        y: ((e.clientY - r.top) / r.height - 0.5) * 2,
      };
      if (dragPanRef.current.active) {
        const dx = ((e.clientX - dragPanRef.current.startX) / r.width) * 100;
        const dy = ((e.clientY - dragPanRef.current.startY) / r.height) * 100;
        // Clamp so we can't push the image completely off-frame
        const nx = Math.max(-8, Math.min(8, dragPanRef.current.baseX + dx * 0.6));
        const ny = Math.max(-6, Math.min(6, dragPanRef.current.baseY + dy * 0.5));
        setDragPan({ x: nx, y: ny });
      }
      if (rafParallax.current == null) {
        rafParallax.current = requestAnimationFrame(() => {
          rafParallax.current = null;
          setParallax({ ...parallaxRef.current });
        });
      }
    };
    const onDown = (e: MouseEvent) => {
      // Only left-button drag on the scene backdrop (not on markers/UI)
      if (e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      if (target && target.closest("[data-hotspot], [data-ui]")) return;
      dragPanRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        baseX: dragPan.x,
        baseY: dragPan.y,
      };
      el.style.cursor = "grabbing";
    };
    const onUp = () => {
      if (!dragPanRef.current.active) return;
      dragPanRef.current.active = false;
      el.style.cursor = "";
      // Ease back toward center so the room settles
      setDragPan(p => ({ x: p.x * 0.4, y: p.y * 0.4 }));
      window.setTimeout(() => setDragPan({ x: 0, y: 0 }), 260);
    };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      if (rafParallax.current) cancelAnimationFrame(rafParallax.current);
      rafParallax.current = null;
    };
  }, [settings.parallax, settings.reducedMotion, screen, room, closeup, dragPan.x, dragPan.y]);

  useEffect(() => {

    if (screen !== "game") return;
    const totalTargets = hotspots.length + availableExits.length;

    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if (k === "h") { setShowHelp(v => !v); return; }
      if (k === "m") { setShowBook(v => !v); return; }
      if (k === ",") { setShowSettings(v => !v); return; }
      if (k === "r") { restartDemo(); return; }
      if (k === "n") { requestHint(); return; }
      if (e.key === "`" || e.key === "~") { setSettings(s => ({ ...s, debugHotspots: !s.debugHotspots })); return; }

      if (k === "escape" || k === "backspace") {
        if (showHelp) { setShowHelp(false); return; }
        if (showBook) { setShowBook(false); return; }
        
        if (showSettings) { setShowSettings(false); return; }
        if (closeup) { setCloseup(null); setVnChoices([]); return; }
        return;
      }
      if (vnChoices.length > 0) {
        if (k === "arrowdown" || k === "arrowright" || k === "s" || k === "d") {
          e.preventDefault();
          setFocusIdx(i => (i + 1) % vnChoices.length);
        } else if (k === "arrowup" || k === "arrowleft" || k === "w" || k === "a") {
          e.preventDefault();
          setFocusIdx(i => (i - 1 + vnChoices.length) % vnChoices.length);
        } else if (k === "enter" || k === " ") {
          e.preventDefault();
          vnChoices[focusIdx]?.onPick();
        }
        return;
      }
      if (k === "arrowright" || k === "d" || k === "arrowdown" || k === "s") {
        e.preventDefault();
        setFocusIdx(i => (i + 1) % Math.max(1, totalTargets));
      } else if (k === "arrowleft" || k === "a" || k === "arrowup" || k === "w") {
        e.preventDefault();
        setFocusIdx(i => (i - 1 + Math.max(1, totalTargets)) % Math.max(1, totalTargets));
      } else if (k === "enter" || k === " ") {
        e.preventDefault();
        if (focusIdx < hotspots.length) hotspots[focusIdx]?.onInspect();
        else availableExits[focusIdx - hotspots.length] && gotoRoom(availableExits[focusIdx - hotspots.length]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [screen, hotspots, availableExits, vnChoices, focusIdx, closeup, showHelp, showBook, showSettings, gotoRoom]);

  /* ---------------------- soft hint if stuck ---------------------- */
  useEffect(() => {
    if (screen !== "game" || room !== "bedroom" || done.has("phone")) return;
    const t = window.setTimeout(() => {
      if (!done.has("phone")) {
        setHintPulse(true);
        setVnLine(v => v ?? { speaker: "Hint", text: "The phone can make the hallway available." });
      }
    }, 45000);
    return () => window.clearTimeout(t);
  }, [screen, room, done]);

  useEffect(() => {
    if (tutorialActive && frontDoorUnlocked) setTutorialActive(false);
  }, [tutorialActive, frontDoorUnlocked]);

  /* Drag-to-remap hotspots in debug mode */
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const el = sceneRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100));
      const y = Math.max(0, Math.min(100, ((e.clientY - r.top) / r.height) * 100));
      setHotspotOverrides(prev => ({
        ...prev,
        [dragging.scene]: { ...(prev[dragging.scene] ?? {}), [dragging.id]: { x, y } },
      }));
    };
    const onUp = () => setDragging(null);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [dragging]);

  const resetOverridesForScene = useCallback(() => {
    setHotspotOverrides(prev => { const n = { ...prev }; delete n[sceneKey]; return n; });
  }, [sceneKey]);
  const copyOverrides = useCallback(() => {
    try { navigator.clipboard.writeText(JSON.stringify(hotspotOverrides, null, 2)); } catch {}
  }, [hotspotOverrides]);

  /* ================================================================ */
  /* Render                                                            */
  /* ================================================================ */

  if (screen === "title") {
    return <TitleScreen hasSave={hasSave} onBegin={beginNew} onContinue={continueSave} onHelp={() => setShowHelp(true)} showHelp={showHelp} closeHelp={() => setShowHelp(false)} />;
  }
  if (screen === "ending" && ending) {
    return <EndingScreen id={ending} memory={memory} wrongCount={wrongCount} onRestart={restartDemo} />;
  }

  const sceneImg = closeup === "phone" ? phoneImg : SCENE_IMG[room];

  /* ---------------------- guided walkthrough ---------------------- */
  const tutorialStep: null | { room: RoomId; hotspotId?: string; doorwayTo?: RoomId; prompt: string } = (() => {
    if (!tutorialActive) return null;
    if (!done.has("glasses"))          return { room: "bedroom", hotspotId: "glasses", prompt: "Your glasses are on the sill — the room needs edges before you can trust it." };
    if (!done.has("note"))             return { room: "bedroom", hotspotId: "note",    prompt: "There's a note by the bed in your own handwriting. Read it." };
    if (!done.has("phone"))            return { room: "bedroom", hotspotId: "phone",   prompt: "Ana is waiting on a message. Pick up the phone." };
    if (room === "bedroom")            return { room: "bedroom", doorwayTo: "hallway", prompt: "Step into the hallway — the day is on the other side of the door." };
    if (kitchenCount < KITCHEN_MIN && room === "hallway") return { room: "hallway", doorwayTo: "kitchen", prompt: "Head to the kitchen. Something warm first." };
    if (kitchenCount < KITCHEN_MIN && room === "kitchen") return { room: "kitchen", hotspotId: "k-kettle", prompt: `Two small kitchen things (${kitchenCount}/${KITCHEN_MIN}). Kettle, fridge, toast — pick any two.` };
    if (bathCount < BATH_MIN && room === "kitchen") return { room: "kitchen", doorwayTo: "hallway", prompt: "Back to the hallway, then across to the bathroom." };
    if (bathCount < BATH_MIN && room === "hallway") return { room: "hallway", doorwayTo: "bathroom", prompt: "The bathroom now — meet the mirror before you leave." };
    if (bathCount < BATH_MIN && room === "bathroom") return { room: "bathroom", hotspotId: "b-mirror", prompt: `Two small bathroom things (${bathCount}/${BATH_MIN}). Mirror, meds, tap, toothbrush — pick any two.` };
    if (frontDoorUnlocked && room !== "hallway") return { room, doorwayTo: "hallway", prompt: "Back to the hallway. The front door is ready for you." };
    if (frontDoorUnlocked && room === "hallway") return { room: "hallway", hotspotId: "frontdoor", prompt: "You have what you need. The front door." };
    return null;
  })();
  const pulseId = tutorialStep?.hotspotId;

  /* Progressive clarity — the further along the player is, the more the world
     comes into focus and saturation. Wrong choices still smear it back. */
  const progress = Math.min(1, done.size / TOTAL_TASKS);
  const rawBlur = Math.min(6, wrongCount * 1.3);
  const rawDesat = Math.max(0.55, 1 - wrongCount * 0.09);
  /* Baseline 0.6px blur simulates slightly-below-average acuity (~20/40) even
     at full progress — the world never becomes hyper-sharp. */
  const blurPx = 0.6 + Math.max(0, rawBlur * (1 - progress * 0.75));
  const desat  = Math.min(1.1, rawDesat + progress * 0.4);
  const warmth = progress; // 0 → 1 warm color wash near the end

  /* Distortion driven by dissonance — chromatic aberration + subtle screen tear */
  const aber = Math.min(0.7, dissonance * 0.15);
  const tear = Math.min(0.55, Math.max(0, dissonance - 2) * 0.2);

  const px = settings.parallax && !settings.reducedMotion ? parallax : { x: 0, y: 0 };

  return (
    <div className={`fixed inset-0 bg-black text-foreground select-none overflow-hidden cursor-open ${settings.dyslexiaFont ? "dyslexia-font" : ""}`}>
      {/* Full-bleed scene (ref used for hotspot drag coordinate mapping) */}
      <div ref={sceneRef} className="absolute inset-0">
        <img
          src={sceneImg}
          alt={closeup === "phone" ? "Phone close-up" : ROOM_LABEL[room]}
          className="absolute inset-0 h-full w-full object-cover"
          style={{
            animation: settings.reducedMotion ? undefined : "drift 24s ease-in-out infinite",
            filter: `blur(${blurPx}px) saturate(${desat.toFixed(2)}) brightness(${(0.42 + progress * 0.6).toFixed(3)})`,
            transition: dragPanRef.current.active
              ? "filter 700ms ease-out"
              : "filter 700ms ease-out, transform 380ms ease-out",
            transform: `scale(1.08) translate(${(-px.x * 1.2 + dragPan.x).toFixed(2)}%, ${(-px.y * 0.8 + dragPan.y).toFixed(2)}%)`,
            willChange: "transform, filter",
          }}
          draggable={false}
        />
        <div className="ink-drips absolute inset-0" style={{ opacity: room === "bedroom" ? 0.7 : 1 }} />
        {room === "bedroom" && !closeup && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: "radial-gradient(ellipse 42% 34% at 74% 26%, oklch(0.85 0.10 78 / 10%), transparent 78%)",
              mixBlendMode: "soft-light",
            }}
          />
        )}
        {settings.foliage > 0 && (
          <div
            className="ghibli-foliage ghibli-foliage-sway absolute inset-0 pointer-events-none"
            style={{
              opacity: settings.foliage,
              transform: `translate(${(-px.x * 0.3).toFixed(2)}%, ${(-px.y * 0.2).toFixed(2)}%)`,
            }}
          />
        )}
        {/* Progressive warm color wash — grows as the player nears the end */}
        {warmth > 0 && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background: "radial-gradient(ellipse 80% 60% at 50% 55%, oklch(0.78 0.12 70 / 22%), transparent 75%), linear-gradient(180deg, oklch(0.55 0.10 145 / 8%), oklch(0.70 0.09 60 / 10%))",
              opacity: warmth,
              mixBlendMode: "soft-light",
              transition: "opacity 900ms ease-out",
            }}
          />
        )}
        {/* Dust motes drifting through the room */}
        {!settings.reducedMotion && !closeup && <div className="dust-motes" />}
        {/* Kettle steam plume */}
        {room === "kitchen" && !closeup && (
          <>
            <div className="steam-plume" style={{ left: "17%", top: "44%" }} />
            <div className="ambient-curtain" style={{ left: "42%", top: "18%", width: "18%", height: "34%" }} />
          </>
        )}
        {/* Bedroom curtain billow + window light shimmer */}
        {room === "bedroom" && !closeup && !settings.reducedMotion && (
          <>
            <div className="ambient-curtain" style={{ left: "18%", top: "10%", width: "22%", height: "48%" }} />
            <div className="ambient-curtain ambient-curtain-delay" style={{ left: "36%", top: "12%", width: "18%", height: "44%" }} />
            <div className="ambient-light-shaft" style={{ left: "20%", top: "8%", width: "38%", height: "70%" }} />
          </>
        )}
        {/* Hallway: front-door light breathes, hanging plant sways */}
        {room === "hallway" && !closeup && !settings.reducedMotion && (
          <>
            <div className="ambient-door-glow" style={{ left: "58%", top: "22%", width: "18%", height: "38%" }} />
            <div className="ambient-sway" style={{ left: "8%", top: "6%", width: "14%", height: "22%" }} />
            <div className="ambient-sway ambient-sway-delay" style={{ right: "6%", top: "8%", width: "14%", height: "22%" }} />
          </>
        )}
        {/* Bathroom: window shimmer + fern sway */}
        {room === "bathroom" && !closeup && !settings.reducedMotion && (
          <>
            <div className="ambient-light-shaft" style={{ left: "2%", top: "6%", width: "26%", height: "60%" }} />
            <div className="ambient-sway" style={{ left: "0%", bottom: "10%", width: "16%", height: "36%" }} />
          </>
        )}
        {settings.grain > 0 && <div className="film-grain" style={{ opacity: 0.18 * settings.grain * (1 - progress * 0.5) }} />}
        {/* Chromatic aberration + screen tear on dissonance */}
        <div className="chromatic-aberration" style={{ ["--aber" as string]: aber }} />
        <div className="screen-tear" style={{ ["--tear" as string]: tear }} />
        <div className="pointer-events-none absolute inset-0 vision-mask" />
        <div className="pointer-events-none absolute inset-0 ink-vignette" />
      </div>


      {/* Top bar */}
      <div className="absolute top-0 inset-x-0 z-40 flex items-center justify-between px-4 py-2 bg-black/50 backdrop-blur-sm border-b border-white/10">
        <div className="font-serif text-sm opacity-80">
          Soft Recall · <span className="opacity-70">{ROOM_LABEL[room]}</span>
          {wrongCount > 0 && <span className="ml-3 text-[11px] text-rose-300/80 italic">the morning feels blurred</span>}
        </div>
        <div className="flex gap-2 text-xs">
          <TopBtn onClick={() => setShowBook(v => !v)} label="Memory Book" hint="M" />
          
          <TopBtn onClick={() => setShowHelp(v => !v)} label="Help" hint="H" />
          <TopBtn onClick={() => setShowSettings(v => !v)} label="Settings" hint="," />
        </div>
      </div>

      {/* Tutorial banner */}
      {tutorialStep && (
        <div className="absolute top-11 left-1/2 -translate-x-1/2 z-30 max-w-2xl w-[min(92%,720px)]">
          <div className="flex items-start gap-3 rounded-md border border-[color:var(--color-glow)]/40 bg-black/70 px-3 py-2 text-sm shadow-lg">
            <span className="font-hand text-[color:var(--color-glow)] text-base leading-none pt-0.5">guide</span>
            <span className="font-serif opacity-90 leading-snug">{tutorialStep.prompt}</span>
            <button
              onClick={() => setTutorialActive(false)}
              className="ml-auto text-[11px] opacity-60 hover:opacity-100 underline underline-offset-2"
              title="Turn off the guide"
            >
              I've got it
            </button>
          </div>
        </div>
      )}

      {/* Memory toast */}
      {toast && (
        <div key={toast.id} className="absolute right-4 top-14 z-40 max-w-xs animate-[fade-in_0.4s_ease-out] rounded border border-[color:var(--color-glow)]/40 bg-black/75 backdrop-blur px-3 py-2 shadow-lg">
          <div className="font-hand text-xs text-[color:var(--color-glow)]/90">+ Memory Book · {toast.section}</div>
          <div className="font-serif text-sm mt-0.5">{toast.title}</div>
          <button onClick={() => { setShowBook(true); setToast(null); }} className="mt-1 text-[11px] opacity-70 hover:opacity-100 underline underline-offset-2">Open (M)</button>
        </div>
      )}

      {/* Hotspot layer */}
      <div className="absolute inset-0 z-10">
        {hotspots.map((h, i) => {
          const isDone = done.has(h.id);
          return (
            <HotspotMarker
              key={h.id}
              hotspot={h}
              scale={settings.markerScale}
              focused={focusIdx === i}
              done={isDone}
              pulse={pulseId === h.id || (hintPulse && (h.id === nextTaskId || h.id === "phone"))}
              debug={settings.debugHotspots}
              onInspect={h.onInspect}
              onDebugMouseDown={(e) => { e.preventDefault(); setDragging({ scene: sceneKey, id: h.id }); }}
              onHoverThought={isDone ? (() => {
                const pool = REVISIT_THOUGHTS[h.id];
                if (!pool || pool.length === 0) return;
                setThought({ id: h.id, text: pool[Math.floor(Math.random() * pool.length)] });
              }) : undefined}
              onLeaveThought={() => setThought(t => (t && t.id === h.id ? null : t))}
            />
          );
        })}
        {thought && (
          <div className="pointer-events-none absolute left-1/2 top-20 -translate-x-1/2 z-30 rounded bg-black/70 backdrop-blur px-3 py-1 text-sm italic font-serif text-[color:var(--color-glow)]/90 animate-[fade-in_0.3s_ease-out]">
            {thought.text}
          </div>
        )}

        {settings.debugHotspots && (
          <div className="absolute top-14 left-3 z-40 rounded border border-emerald-400/60 bg-black/80 px-3 py-2 text-xs text-emerald-200 font-mono max-w-xs">
            <div className="flex items-center gap-2">
              <span className="font-serif not-italic">Hotspot debug ({sceneKey})</span>
              <span className="opacity-60">[~]</span>
            </div>
            <div className="mt-1 opacity-80">Drag any marker to remap. Overrides saved to localStorage.</div>
            <div className="mt-2 flex gap-2">
              <button onClick={copyOverrides} className="rounded bg-emerald-500/20 px-2 py-0.5 hover:bg-emerald-500/40">Copy JSON</button>
              <button onClick={resetOverridesForScene} className="rounded bg-rose-500/20 px-2 py-0.5 hover:bg-rose-500/40">Reset scene</button>
              <button onClick={() => setHotspotOverrides({})} className="rounded bg-rose-500/20 px-2 py-0.5 hover:bg-rose-500/40">Reset all</button>
            </div>
          </div>
        )}
      </div>


      {/* Close-up back button */}
      {closeup && (
        <button
          onClick={() => { setCloseup(null); setVnChoices([]); }}
          className="absolute left-3 top-12 z-30 rounded bg-black/70 px-3 py-1 text-xs text-white hover:bg-black/90"
        >
          ← Back to room (Esc)
        </button>
      )}

      {/* Bottom UI stack: doorways + VN + mini map */}
      <div className="absolute inset-x-0 bottom-0 z-20 px-3 pb-3 pt-2 bg-gradient-to-t from-black/85 via-black/60 to-transparent">
        <div className="mx-auto max-w-5xl">
          {/* Doorways */}
          {!closeup && (
            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-md border border-white/10 bg-black/55 px-3 py-2 text-sm">
              <span className="font-hand text-base opacity-70 mr-2">Doorways —</span>
              {availableExits.length === 0 ? (
                <span className="opacity-60 italic">No exits yet. Look around.</span>
              ) : availableExits.map((r, i) => (
                <button
                  key={r}
                  onClick={() => gotoRoom(r)}
                  className={`choice-btn rounded px-3 py-1 text-sm hover:brightness-110 ${
                    focusIdx === hotspots.length + i ? "ring-2 ring-[color:var(--color-glow)]" : ""
                  } ${tutorialStep?.doorwayTo === r ? "ring-2 ring-[color:var(--color-glow)] animate-[pulse-soft_1.6s_ease-in-out_infinite]" : ""}`}
                >
                  → {ROOM_LABEL[r]} {visited.has(r) ? "" : <span className="opacity-60 text-[11px]">(new)</span>}
                </button>
              ))}
              {room === "hallway" && !frontDoorUnlocked && (
                <span className="ml-auto text-xs opacity-60 italic">
                  Kitchen {kitchenCount}/{KITCHEN_MIN} · Bathroom {bathCount}/{BATH_MIN}
                </span>
              )}
            </div>
          )}

          {/* VN panel */}
          <div className="vn-panel rounded-md px-4 py-3 min-h-[110px]" style={{ fontSize: `${settings.subtitleScale}em` }}>
            {vnLine ? (
              <div>
                <div className="font-hand text-[color:var(--color-glow)] text-lg leading-none">{vnLine.speaker}</div>
                <div className="mt-1 font-serif text-[15px] leading-snug">{vnLine.text}</div>
              </div>
            ) : (
              <div className="opacity-60 italic text-sm">Click a glowing object, or use a Doorway.</div>

            )}
            {vnChoices.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {vnChoices.map((c, i) => (
                  <button
                    key={c.id}
                    onClick={c.onPick}
                    className={`choice-btn rounded px-3 py-2 text-left text-sm ${
                      focusIdx === i ? "ring-2 ring-[color:var(--color-glow)]" : ""
                    } ${c.tone === "wrong" ? "opacity-80" : ""}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Mini map */}
          <MiniMap current={room} visited={visited} unlocked={unlocked} onJump={(r) => availableExits.includes(r) && gotoRoom(r)} />
        </div>
      </div>

      {showBook && <MemoryBook memory={memory} onClose={() => setShowBook(false)} />}
      
      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} onRestart={restartDemo} />}
      {showSettings && <SettingsOverlay settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} onRestart={restartDemo} />}
      {mini && <MiniGameOverlay spec={mini} />}
      {!onboarded && <OnboardingOverlay onDone={finishOnboarding} />}
      {breathing && <BreatheOverlay phase={breathing} />}
      {dissonance >= 2 && !breathing && (
        <div className="absolute left-1/2 bottom-[calc(100%-70px)] -translate-x-1/2 z-30 pointer-events-none text-[11px] text-rose-200/80 italic animate-[fade-in_0.4s_ease-out]" style={{ top: 44 }}>
          hold <kbd className="not-italic px-1 rounded bg-white/10">B</kbd> to breathe · steady the room
        </div>
      )}
      {hintCooldown > 0 && (
        <div className="absolute right-4 bottom-[210px] z-30 pointer-events-none text-[10px] opacity-50 font-mono">hint {hintCooldown}s</div>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

function TitleScreen({ hasSave, onBegin, onContinue, onHelp, showHelp, closeHelp }:{
  hasSave: boolean; onBegin: () => void; onContinue: () => void; onHelp: () => void;
  showHelp: boolean; closeHelp: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-paperfield flex flex-col items-center justify-center px-6 text-center">
      <div className="max-w-xl">
        <div className="font-hand text-2xl opacity-70">a first-person visual novel</div>
        <h1 className="font-serif text-6xl md:text-7xl tracking-tight mt-2">Soft Recall</h1>
        <p className="mt-6 font-serif text-lg opacity-80 leading-snug">
          A quiet morning. A room that has to be re-learned, gently. This is a short PC demo.
        </p>
        <div className="mt-8 flex flex-col gap-3 items-center">
          <button onClick={onBegin} className="choice-btn rounded px-6 py-3 text-lg w-64">Begin</button>
          {hasSave && (
            <button onClick={onContinue} className="choice-btn rounded px-6 py-3 w-64">Continue the morning</button>
          )}
          <button onClick={onHelp} className="choice-btn rounded px-6 py-2 w-64 text-sm opacity-80">Controls</button>
        </div>
        <p className="mt-6 text-xs opacity-50">PC-only demo · mouse + keyboard</p>
      </div>
      {showHelp && <HelpOverlay onClose={closeHelp} />}
    </div>
  );
}

function EndingScreen({ id, memory, wrongCount, onRestart }:{
  id: EndingId; memory: MemoryEntry[]; wrongCount: number; onRestart: () => void;
}) {
  const copy = {
    supported: {
      title: "Supported Departure",
      body: "You leave with the small things you needed: keys, coat, phone. The morning didn't win. It was met.",
    },
    hurried: {
      title: "Hurried Out",
      body: "The door slams a beat too hard. You are outside. You are not yet with yourself.",
    },
    withdrawn: {
      title: "Quiet Exit",
      body: "You leave without saying much to the morning, and it lets you go. There is still tomorrow to try again.",
    },
  }[id];
  return (
    <div className="fixed inset-0 bg-paperfield flex items-center justify-center px-6 overflow-auto">
      <div className="max-w-2xl text-center py-10">
        <div className="font-hand text-2xl opacity-70">ending</div>
        <h2 className="font-serif text-5xl mt-1">{copy.title}</h2>
        <p className="mt-6 font-serif text-lg opacity-85 leading-snug">{copy.body}</p>
        <div className="mt-4 text-xs opacity-60">
          Kept: {memory.length} · Missteps: {wrongCount}
        </div>
        <div className="mt-8 text-left max-w-md mx-auto">
          <h3 className="font-serif text-xl mb-2">Kept from this morning</h3>
          <ul className="space-y-1 text-sm opacity-85">
            {memory.length === 0 ? <li className="italic opacity-60">Nothing kept.</li> :
              memory.map((m, i) => <li key={i}>· <b>{m.title}</b> <span className="opacity-60">— {m.section}</span></li>)}
          </ul>
        </div>
        <div className="mt-8 flex justify-center gap-2">
          <button onClick={onRestart} className="choice-btn rounded px-5 py-2">Play again</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Overlays & bits                                                     */
/* ------------------------------------------------------------------ */

function TopBtn({ onClick, label, hint }:{ onClick: () => void; label: string; hint: string; }) {
  return (
    <button onClick={onClick} className="rounded border border-white/15 bg-white/5 px-2 py-1 hover:bg-white/10">
      {label} <span className="opacity-50 ml-1">[{hint}]</span>
    </button>
  );
}

/* Hotspot marker with hover-wobble + press-and-hold to inspect. A quick tap
   still works as a fallback so the interaction feels tactile without being
   punishing. The hit target is a tight circle in the visual center. */
const HOLD_MS = 260;
const HotspotMarker = memo(function HotspotMarker({ hotspot, scale, focused, done, pulse, debug, onInspect, onDebugMouseDown, onHoverThought, onLeaveThought }:{
  hotspot: Hotspot;
  scale: number;
  focused: boolean;
  done: boolean;
  pulse: boolean;
  debug: boolean;
  onInspect: () => void;
  onDebugMouseDown: (e: React.MouseEvent) => void;
  onHoverThought?: () => void;
  onLeaveThought?: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [holding, setHolding] = useState(false);
  const holdRef = useRef<{ start: number; timer: number | null; fired: boolean }>({ start: 0, timer: null, fired: false });

  const size = Math.round(36 * scale);                       // visual glow diameter
  const hit  = Math.max(18, Math.round(size * 0.62));         // click target — larger than before

  const cancelHold = () => {
    if (holdRef.current.timer) { window.clearTimeout(holdRef.current.timer); holdRef.current.timer = null; }
    setHolding(false);
  };

  const startHold = (e: React.PointerEvent) => {
    if (debug) return;
    e.preventDefault();
    holdRef.current.fired = false;
    holdRef.current.start = performance.now();
    setHolding(true);
    holdRef.current.timer = window.setTimeout(() => {
      holdRef.current.fired = true;
      setHolding(false);
      onInspect();
    }, HOLD_MS);
  };

  const endHold = () => {
    if (debug) return;
    if (holdRef.current.fired) { cancelHold(); return; }
    // Quick tap fallback: released before hold completed → still inspect.
    cancelHold();
    onInspect();
  };

  useEffect(() => () => cancelHold(), []);

  return (
    <div
      data-hotspot
      className="absolute -translate-x-1/2 -translate-y-1/2 cursor-inspect"
      style={{ left: `${hotspot.x}%`, top: `${hotspot.y}%`, width: size, height: size, zIndex: debug ? 30 : undefined }}
      onMouseEnter={() => { setHover(true); onHoverThought?.(); }}
      onMouseLeave={() => { setHover(false); cancelHold(); onLeaveThought?.(); }}
    >

      {/* decorative glow — no pointer events, so the player must aim at center */}
      <span
        aria-hidden
        className={`pointer-events-none absolute inset-0 rounded-full marker-glow ${pulse ? "animate-[pulse-soft_1.4s_ease-in-out_infinite]" : ""} ${done ? "opacity-40" : "opacity-100"}`}
        style={{
          background: pulse
            ? "radial-gradient(circle, rgba(255,230,170,0.55), rgba(0,0,0,0) 70%)"
            : "radial-gradient(circle, rgba(255,220,150,0.22), rgba(0,0,0,0) 70%)",
          transform: hover ? "scale(1.15)" : "scale(1)",
          transition: "transform 220ms cubic-bezier(.2,.7,.2,1.4)",
          animation: hover && !pulse ? "wobble 900ms ease-in-out infinite" : undefined,
        }}
      />
      {/* Guiding arrow — points down at the interactive object, only until inspected */}
      {!done && !debug && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 -translate-x-1/2 hotspot-arrow"
          style={{ bottom: `calc(100% + 4px)` }}
        >
          <svg width="18" height="22" viewBox="0 0 18 22" fill="none">
            <path
              d="M9 2 L9 16 M3 12 L9 18 L15 12"
              stroke="rgba(255,230,170,0.95)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              filter="drop-shadow(0 0 4px rgba(255,220,150,0.6))"
            />
          </svg>
        </span>
      )}
      {/* progress ring while holding */}
      {holding && (
        <svg aria-hidden className="pointer-events-none absolute inset-0" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15" fill="none" stroke="rgba(255,230,170,0.9)" strokeWidth="2.5"
                  strokeDasharray="94.25" strokeDashoffset="94.25" strokeLinecap="round"
                  style={{ transformOrigin: "center", transform: "rotate(-90deg)",
                           animation: `hs-fill ${HOLD_MS}ms linear forwards` }} />
        </svg>
      )}
      {/* tight center hit-target */}
      <button
        onPointerDown={debug ? undefined : startHold}
        onPointerUp={debug ? undefined : endHold}
        onPointerCancel={debug ? undefined : cancelHold}
        onMouseDown={debug ? onDebugMouseDown : undefined}
        aria-label={hotspot.label}
        className={`group absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${focused ? "ring-2 ring-[color:var(--color-glow)]" : ""} ${debug ? "cursor-move ring-2 ring-emerald-300/80" : "cursor-pointer"}`}
        style={{
          width: hit, height: hit,
          clipPath: "circle(50% at 50% 50%)",
          background: debug ? "rgba(16,185,129,0.35)" : "transparent",
          transform: `translate(-50%, -50%) scale(${holding ? 0.9 : hover ? 1.05 : 1})`,
          transition: "transform 140ms ease-out",
        }}
      >
        <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-[color:var(--color-glow)] text-sm font-serif drop-shadow">
          {done ? "·" : "◎"}
        </span>
        <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap rounded bg-black/80 px-2 py-0.5 text-[11px] text-white opacity-0 group-hover:opacity-100 group-focus:opacity-100 transition">
          {hotspot.label} <span className="opacity-60">— hold</span>{debug ? ` — ${hotspot.x.toFixed(1)}, ${hotspot.y.toFixed(1)}` : ""}
        </span>
      </button>
      {debug && (
        <span className="pointer-events-none absolute left-1/2 top-full mt-3 -translate-x-1/2 whitespace-nowrap rounded bg-emerald-500/90 px-1.5 py-0.5 text-[10px] font-mono text-black">
          {hotspot.id} · {hotspot.x.toFixed(1)},{hotspot.y.toFixed(1)}
        </span>
      )}
    </div>
  );
});


function MiniMap({ current, visited, unlocked, onJump }:{
  current: RoomId; visited: Set<RoomId>; unlocked: Set<RoomId>; onJump: (r: RoomId) => void;
}) {
  const rooms: RoomId[] = ["bedroom", "hallway", "kitchen", "bathroom"];
  return (
    <div className="mt-2 mx-auto max-w-md rounded-md border border-white/10 bg-black/50 px-3 py-1.5">
      <div className="grid grid-cols-4 gap-1">
        {rooms.map(r => {
          const isCur = r === current;
          const isVis = visited.has(r);
          const isUnl = unlocked.has(r);
          return (
            <button
              key={r}
              onClick={() => onJump(r)}
              className={`rounded px-2 py-0.5 text-[11px] border transition
                ${isCur ? "border-[color:var(--color-glow)] bg-white/10" : "border-white/10"}
                ${!isUnl ? "opacity-30 cursor-not-allowed" : "hover:bg-white/10"}
                ${isVis && !isCur ? "opacity-80" : ""}`}
            >
              {ROOM_LABEL[r]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MemoryBook({ memory, onClose }:{ memory: MemoryEntry[]; onClose: () => void; }) {
  const sections: MemoryEntry["section"][] = ["Fragments", "Messages", "Routines", "Reflections"];
  return (
    <Overlay onClose={onClose} title="Memory Book" hint="M">
      {sections.map(s => {
        const items = memory.filter(m => m.section === s);
        if (items.length === 0) return null;
        return (
          <div key={s} className="mb-4">
            <div className="font-hand text-lg opacity-70">{s}</div>
            <ul className="mt-1 space-y-3">
              {items.map((m, i) => {
                const cites = findCitationsFor(`${m.title} ${m.body}`);
                return (
                  <li key={i}>
                    <div className="font-serif font-semibold">{m.title}</div>
                    <div className="text-sm opacity-80">{m.body}</div>
                    {cites.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1.5 text-[11px]">
                        <span className="opacity-50 italic">sources:</span>
                        {cites.map(c => (
                          <a
                            key={c.url}
                            href={c.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="underline decoration-dotted underline-offset-2 opacity-80 hover:opacity-100 hover:text-[color:var(--color-glow)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-glow)] rounded-sm px-1"
                            aria-label={`${c.venue} — ${c.title} (opens in a new tab)`}
                            title={c.title}
                          >
                            {c.venue}
                          </a>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      {memory.length === 0 && <p className="italic opacity-60">Empty for now. Inspect things to keep them.</p>}
      <ResearchSection defaultOpen />
    </Overlay>
  );
}

/* Best-effort keyword → citation lookup so memory entries can carry
   inline source links to the research they reflect. */
function findCitationsFor(text: string): ResearchEntry[] {
  const t = text.toLowerCase();
  const hits: ResearchEntry[] = [];
  const push = (predicate: boolean, cat: ResearchCategory) => {
    if (!predicate) return;
    RESEARCH_ENTRIES.filter(e => e.category === cat).forEach(e => {
      if (!hits.includes(e)) hits.push(e);
    });
  };
  push(/glasses|blur|mirror|face|see|light|dark|contrast/.test(t), "Perception");
  push(/morning|night|sleep|evening|sundown|dusk|circadian/.test(t), "Circadian");
  push(/kettle|tea|toast|fridge|meds|medication|tooth|tap|brush/.test(t), "Daily routine");
  push(/door|hallway|room|kitchen|bathroom|bedroom|way|lost/.test(t), "Orientation");
  push(/ana|photo|note|letter|memory|remember|hand|writing/.test(t), "Reminiscence");
  push(/breath|calm|panic|steady|slow/.test(t), "Regulation");
  return hits.slice(0, 3);
}

/* ---------------------- Research overlay ------------------------- *
 * Peer-reviewed publications (NIH / PubMed / PMC) that inform the
 * neurodegeneration-adjacent mechanics represented in Soft Recall.   */
type ResearchCategory =
  | "Perception"
  | "Circadian"
  | "Daily routine"
  | "Orientation"
  | "Reminiscence"
  | "Regulation";

type ResearchEntry = {
  category: ResearchCategory;
  feature: string;      // in-game mechanic this study informed
  title: string;
  authors: string;
  venue: string;        // journal, year
  url: string;          // PubMed / PMC link
  takeaway: string;     // one-line synthesis tying it to the game
};

const RESEARCH_ENTRIES: ResearchEntry[] = [
  {
    category: "Perception",
    feature: "Fuzz, blur & fading contrast between tasks",
    title: "Visual contrast sensitivity in AD, MCI, and older adults with cognitive complaints",
    authors: "Risacher SL, et al.",
    venue: "Neurobiology of Aging, 2013 (PMC3545045)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC3545045/",
    takeaway: "Loss of low-contrast vision is measurable in early Alzheimer's — the scene's soft haze mirrors that early perceptual thinning.",
  },
  {
    category: "Perception",
    feature: "Vision-first onboarding (glasses before anything else)",
    title: "The Vision–Cognition Connection: Visual processing deficits as early indicators of Alzheimer's disease",
    authors: "Alharbi M.",
    venue: "Alzheimer's & Dementia, 2025 (PMC12738266)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC12738266/",
    takeaway: "Visual processing changes precede clinical dementia — restoring 'edges' first models how correcting sensory input steadies cognition.",
  },
  {
    category: "Circadian",
    feature: "Late-day dimming, warm→cool light, evening dread",
    title: "Sundowning Syndrome in Dementia: Mechanisms, Diagnosis, and Treatment",
    authors: "Reimus M, Siemiński M.",
    venue: "Journal of Clinical Medicine, 2025 (PMC11856004)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11856004/",
    takeaway: "Agitation and confusion rise as ambient light falls — the room's brightness curve reflects this circadian vulnerability.",
  },
  {
    category: "Circadian",
    feature: "Progressive brightness / clarity as tasks complete",
    title: "Potential Pathways for Circadian Dysfunction and Sundowning in Alzheimer's Disease",
    authors: "Canevelli M, Valletta M, et al.",
    venue: "Frontiers in Neuroscience, 2020 (PMC7494756)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7494756/",
    takeaway: "SCN circadian degeneration explains why steady light + routine anchors orientation — the game rewards routine with clarity.",
  },
  {
    category: "Daily routine",
    feature: "Kitchen & bathroom mini-tasks (kettle, tap, toothbrush)",
    title: "A systematic review of psychometric properties of ADL questionnaires in older adults with neurocognitive disorders",
    authors: "Provencher V, et al.",
    venue: "BMC Geriatrics, 2025 (PMC11758263)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC11758263/",
    takeaway: "Activities of Daily Living (ADLs) are the clinical yardstick for decline — the small home tasks are the same domains clinicians score.",
  },
  {
    category: "Daily routine",
    feature: "Medication cabinet / meds hotspot",
    title: "A systematic review of medication non-adherence in persons with dementia or cognitive impairment",
    authors: "Smith D, Lovell J, et al.",
    venue: "PLoS ONE, 2017 (PMC5293218)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC5293218/",
    takeaway: "Non-adherence is common and dangerous in cognitive impairment — the meds beat surfaces that risk without dramatizing it.",
  },
  {
    category: "Reminiscence",
    feature: "Memory Book (write-down of fragments & routines)",
    title: "Reminiscence therapy on cognition, depression and QoL in Alzheimer's disease — systematic review of RCTs",
    authors: "Cuevas PEG, et al.",
    venue: "Healthcare, 2022 (PMID 36233620)",
    url: "https://pubmed.ncbi.nlm.nih.gov/36233620/",
    takeaway: "Structured reminiscence improves mood and cognition — the Memory Book is a play-form of that intervention.",
  },
  {
    category: "Orientation",
    feature: "Doorways, mini-map, disoriented exits",
    title: "Spatial Disorientation in Alzheimer's Disease: The Missing Path from Virtual Reality to Real World",
    authors: "Puthusseryppady V, et al.",
    venue: "Frontiers in Aging Neuroscience, 2020 (PMC7652847)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC7652847/",
    takeaway: "Getting lost at home is an early Alzheimer's signature — locked/unlocked doorways externalise that shrinking mental map.",
  },
  {
    category: "Orientation",
    feature: "Dementia-friendly room design (contrast markers, plant cues)",
    title: "Dementia-Friendly Design: Criteria and Typologies Supporting Wayfinding",
    authors: "van Buuren LPG, Mohammadi M.",
    venue: "HERD: Health Environments Research & Design, 2021 (PMC8725382)",
    url: "https://pmc.ncbi.nlm.nih.gov/articles/PMC8725382/",
    takeaway: "Landmarks, contrast and consistent cues reduce wayfinding failure — the glowing markers borrow the same principle.",
  },
  {
    category: "Regulation",
    feature: "Hold-B breathing ritual to steady dissonance",
    title: "Heart-focused breathing and perceptions of burden in Alzheimer's caregivers: RCT pilot",
    authors: "May RW, et al.",
    venue: "Complementary Therapies in Medicine, 2021 (PMID 33639543)",
    url: "https://pubmed.ncbi.nlm.nih.gov/33639543/",
    takeaway: "Paced breathing measurably lowers stress load in dementia contexts — the breathe ritual is a nod to that evidence base.",
  },
];

function ResearchSection({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState<ResearchCategory | "All">("All");
  const cats: (ResearchCategory | "All")[] = useMemo(() => {
    const set = new Set<ResearchCategory>();
    RESEARCH_ENTRIES.forEach(e => set.add(e.category));
    return ["All", ...Array.from(set)];
  }, []);
  const visible = filter === "All"
    ? RESEARCH_ENTRIES
    : RESEARCH_ENTRIES.filter(e => e.category === filter);

  return (
    <section className="mt-6 border-t border-white/10 pt-4" aria-labelledby="research-heading">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        aria-expanded={open}
        aria-controls="research-list"
        className="w-full flex items-center justify-between text-left group focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-glow)] rounded"
      >
        <span>
          <span id="research-heading" className="font-hand text-lg opacity-80 block">
            Research this leans on
          </span>
          <span className="text-xs opacity-60 italic">
            Peer-reviewed sources (NIH / PubMed / PMC), each tied to a mechanic used in the game.
          </span>
        </span>
        <span aria-hidden className="opacity-70 text-lg ml-2">{open ? "–" : "+"}</span>
      </button>

      {open && (
        <>
          <div
            role="group"
            aria-label="Filter research by mechanic"
            className="mt-3 flex flex-wrap gap-1.5"
          >
            {cats.map(c => {
              const active = c === filter;
              return (
                <button
                  key={c}
                  type="button"
                  onClick={() => setFilter(c)}
                  aria-pressed={active}
                  className={`px-2.5 py-1 rounded-full text-xs border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-glow)] ${
                    active
                      ? "bg-[color:var(--color-ember)]/25 border-[color:var(--color-ember)]/70 text-[color:var(--color-glow)]"
                      : "border-white/20 opacity-70 hover:opacity-100"
                  }`}
                >
                  {c}
                </button>
              );
            })}
          </div>

          <ul id="research-list" className="mt-3 space-y-4" aria-live="polite">
            {visible.map((e, i) => (
              <li key={i} className="border-l-2 border-[color:var(--color-ember)]/50 pl-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-white/8 border border-white/15 opacity-80">
                    {e.category}
                  </span>
                  <span className="font-hand text-[color:var(--color-glow)]/90 text-base">
                    {e.feature}
                  </span>
                </div>
                <div className="font-serif font-semibold leading-snug mt-0.5">
                  <a
                    href={e.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-dotted underline-offset-2 hover:text-[color:var(--color-glow)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-glow)] rounded-sm"
                    aria-label={`${e.title} — opens in a new tab on PubMed`}
                  >
                    {e.title}
                  </a>
                </div>
                <div className="text-xs opacity-70 italic">{e.authors} · {e.venue}</div>
                <div className="text-sm opacity-90 mt-1">{e.takeaway}</div>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="italic opacity-60 text-sm list-none">
                No citations under this mechanic yet.
              </li>
            )}
            <li className="text-[11px] opacity-60 italic pt-1 list-none">
              Educational reference only — not medical advice. If a loved one is
              showing signs of memory change, please talk to a qualified clinician.
            </li>
          </ul>
        </>
      )}
    </section>
  );
}





function HelpOverlay({ onClose, onRestart }:{ onClose: () => void; onRestart?: () => void; }) {
  return (
    <Overlay onClose={onClose} title="How it plays" hint="H">
      <Section title="Inspecting objects">
        Click any glowing marker (◎) on the scene. The text box tells you what you found and what you feel about it. Faded dots (·) mean you've already looked.
      </Section>
      <Section title="Moving rooms">
        Use the <b>Doorways</b> strip. Only unlocked exits appear. The map is a guide.
      </Section>
      <Section title="If the scene blurs">
        Rushed or unkind choices smear the morning. Slow down; the next kind choice steadies things.
      </Section>
      <Section title="Memory Book">
        Press <b>M</b>. New entries pop up briefly in the corner.
      </Section>
      <Section title="Keyboard controls">
        <ul className="text-sm space-y-0.5">
          <li>Arrows / WASD — cycle objects & doorways (or choices)</li>
          <li>Enter / Space — inspect / confirm</li>
          <li>Esc / Backspace — close overlay / leave close-up</li>
          <li>H — Help · M — Memory Book · , — Settings · R — Restart</li>
          <li>N — Nudge / hint (15s cooldown)</li>
          <li>Hold B — Breathe to steady the room</li>
        </ul>
      </Section>

      {onRestart && (
        <button onClick={onRestart} className="mt-2 choice-btn rounded px-3 py-1 text-sm">Restart Demo</button>
      )}
    </Overlay>
  );
}

function SettingsOverlay({ settings, onChange, onClose, onRestart }:{
  settings: Settings; onChange: (s: Settings) => void; onClose: () => void; onRestart: () => void;
}) {
  return (
    <Overlay onClose={onClose} title="Settings" hint=",">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings.reducedMotion} onChange={(e) => onChange({ ...settings, reducedMotion: e.target.checked })} />
        Reduced motion
      </label>
      <div className="mt-3 text-sm">
        <div>Film grain: {Math.round(settings.grain * 100)}%</div>
        <input type="range" min={0} max={1} step={0.05} value={settings.grain} onChange={(e) => onChange({ ...settings, grain: parseFloat(e.target.value) })} className="w-full" />
      </div>
      <div className="mt-3 text-sm">
        <div>Text softness cap: {Math.round(settings.fuzzCap * 100)}%</div>
        <input type="range" min={0} max={1} step={0.05} value={settings.fuzzCap} onChange={(e) => onChange({ ...settings, fuzzCap: parseFloat(e.target.value) })} className="w-full" />
      </div>
      <div className="mt-3 text-sm">
        <div>Marker scale: {Math.round(settings.markerScale * 100)}%</div>
        <input type="range" min={0.5} max={1.5} step={0.05} value={settings.markerScale} onChange={(e) => onChange({ ...settings, markerScale: parseFloat(e.target.value) })} className="w-full" />
        <div className="text-xs opacity-60 mt-0.5">Smaller markers make the click target tighter (aim for the center).</div>
      </div>
      <div className="mt-3 text-sm">
        <div>Foliage overlay: {Math.round(settings.foliage * 100)}%</div>
        <input type="range" min={0} max={1} step={0.05} value={settings.foliage} onChange={(e) => onChange({ ...settings, foliage: parseFloat(e.target.value) })} className="w-full" />
      </div>
      <div className="mt-4 border-t border-black/10 pt-3">
        <div className="font-hand text-base opacity-70">Audio</div>
        <label className="mt-1 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.muted} onChange={(e) => onChange({ ...settings, muted: e.target.checked })} />
          Mute
        </label>
        <div className="mt-2 text-sm">
          <div>Volume: {Math.round(settings.volume * 100)}%</div>
          <input type="range" min={0} max={1} step={0.05} value={settings.volume} onChange={(e) => onChange({ ...settings, volume: parseFloat(e.target.value) })} className="w-full" disabled={settings.muted} />
        </div>
      </div>
      <div className="mt-4 border-t border-black/10 pt-3">
        <div className="font-hand text-base opacity-70">Accessibility</div>
        <div className="mt-2 text-sm">
          <div>Subtitle size: {Math.round(settings.subtitleScale * 100)}%</div>
          <input type="range" min={0.85} max={1.6} step={0.05} value={settings.subtitleScale} onChange={(e) => onChange({ ...settings, subtitleScale: parseFloat(e.target.value) })} className="w-full" />
        </div>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.dyslexiaFont} onChange={(e) => onChange({ ...settings, dyslexiaFont: e.target.checked })} />
          Dyslexia-friendly font
        </label>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={settings.parallax} onChange={(e) => onChange({ ...settings, parallax: e.target.checked })} />
          Parallax on cursor
        </label>
      </div>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={settings.debugHotspots} onChange={(e) => onChange({ ...settings, debugHotspots: e.target.checked })} />
        Hotspot debug overlay (drag to remap) — toggle with <kbd className="px-1 rounded bg-black/10">~</kbd>
      </label>
      <button onClick={onRestart} className="mt-4 choice-btn rounded px-3 py-1 text-sm">Restart Demo</button>
    </Overlay>
  );
}


function Overlay({ children, onClose, title, hint }:{
  children: React.ReactNode; onClose: () => void; title: string; hint?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="max-w-lg w-full max-h-[85vh] overflow-auto rounded-md bg-[color:var(--color-paper)] text-[color:var(--color-ink)] p-6 shadow-2xl paper-grain relative" onClick={(e) => e.stopPropagation()}>
        <div className="paper-grain-after" />
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-serif text-2xl">{title}</h3>
          <button onClick={onClose} className="text-sm opacity-70 hover:opacity-100">Close {hint ? `[${hint}/Esc]` : "[Esc]"}</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Section({ title, children }:{ title: string; children: React.ReactNode; }) {
  return (
    <div className="mb-3">
      <div className="font-hand text-lg opacity-70">{title}</div>
      <div className="text-sm opacity-90">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Copy helpers                                                        */
/* ------------------------------------------------------------------ */

function roomEnterLine(r: RoomId): string {
  switch (r) {
    case "bedroom":  return "The bed, still warm on one side.";
    case "hallway":  return "A short hallway. Coat hook, front door, two rooms to either side.";
    case "kitchen":  return "Kitchen light. The morning has a smell here.";
    case "bathroom": return "Cold tile. The tap drips once, then stops.";
  }
}

/* ------------------------------------------------------------------ */
/* Mini-games                                                          */
/* ------------------------------------------------------------------ */

function MiniGameOverlay({ spec }: { spec: MiniSpec }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-[fade-in_0.25s_ease-out]">
      <div className="vn-panel rounded-lg px-6 py-5 w-[min(92vw,440px)] text-center">
        <div className="font-hand text-[color:var(--color-glow)] text-xl leading-none">{spec.title}</div>
        <div className="mt-1 font-serif text-sm opacity-80">{spec.hint}</div>
        <div className="mt-4">
          {spec.kind === "brush" && <BrushMini onDone={spec.onDone} />}
          {spec.kind === "sip"   && <HoldMini label="Sip" durationMs={2800} onDone={spec.onDone} />}
          {spec.kind === "pour"  && <HoldMini label="Pour" durationMs={1800} onDone={spec.onDone} />}
          {spec.kind === "knob"  && <KnobMini onDone={spec.onDone} />}
          {spec.kind === "splash" && <TapMini target={4} onDone={spec.onDone} />}
        </div>
        {spec.onCancel && (
          <button
            onClick={spec.onCancel}
            className="mt-4 text-xs opacity-60 hover:opacity-100 underline underline-offset-2"
          >
            step away
          </button>
        )}
      </div>
    </div>
  );
}

function BrushMini({ onDone }: { onDone: () => void }) {
  const TARGET = 8;
  const [count, setCount] = useState(0);
  const [side, setSide] = useState<"L" | "R">("L");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" && side === "L") press("L");
      if (e.key === "ArrowRight" && side === "R") press("R");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);
  const press = (s: "L" | "R") => {
    if (s !== side) return;
    const next = count + 1;
    setCount(next);
    setSide(s === "L" ? "R" : "L");
    if (next >= TARGET) setTimeout(onDone, 220);
  };
  const pct = Math.min(100, (count / TARGET) * 100);
  return (
    <div>
      <div className="flex gap-3 justify-center">
        <button
          onClick={() => press("L")}
          className={`choice-btn rounded px-6 py-3 text-lg ${side === "L" ? "ring-2 ring-[color:var(--color-glow)] animate-[pulse-soft_1s_ease-in-out_infinite]" : "opacity-40"}`}
          disabled={side !== "L"}
        >← Left</button>
        <button
          onClick={() => press("R")}
          className={`choice-btn rounded px-6 py-3 text-lg ${side === "R" ? "ring-2 ring-[color:var(--color-glow)] animate-[pulse-soft_1s_ease-in-out_infinite]" : "opacity-40"}`}
          disabled={side !== "R"}
        >Right →</button>
      </div>
      <div className="mt-4 h-2 w-full overflow-hidden rounded bg-white/10">
        <div className="h-full bg-[color:var(--color-glow)] transition-all duration-200" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs opacity-60">{count}/{TARGET} strokes</div>
    </div>
  );
}

function HoldMini({ label, durationMs, onDone }: { label: string; durationMs: number; onDone: () => void }) {
  const [holding, setHolding] = useState(false);
  const [progress, setProgress] = useState(0);
  const startRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const accumRef = useRef(0);
  const tick = () => {
    const now = performance.now();
    const p = Math.min(1, (accumRef.current + (now - startRef.current)) / durationMs);
    setProgress(p);
    if (p >= 1) { onDone(); return; }
    rafRef.current = requestAnimationFrame(tick);
  };
  const start = () => {
    setHolding(true);
    startRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  };
  const stop = () => {
    setHolding(false);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    accumRef.current += performance.now() - startRef.current;
  };
  useEffect(() => () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); }, []);
  return (
    <div>
      <button
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={() => holding && stop()}
        className={`choice-btn w-full rounded px-6 py-4 text-lg select-none ${holding ? "brightness-125" : ""}`}
      >{holding ? `${label}ing…` : `Hold to ${label}`}</button>
      <div className="mt-4 h-2 w-full overflow-hidden rounded bg-white/10">
        <div className="h-full bg-[color:var(--color-glow)]" style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );
}

function KnobMini({ onDone }: { onDone: () => void }) {
  const [angle, setAngle] = useState(0);
  const [holding, setHolding] = useState(false);
  const startRef = useRef<{ cx: number; cy: number; a0: number; base: number } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const a0 = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    startRef.current = { cx, cy, a0, base: angle };
    setHolding(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!holding || !startRef.current) return;
    const { cx, cy, a0, base } = startRef.current;
    const a = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
    const next = Math.max(0, Math.min(90, base + (a - a0)));
    setAngle(next);
    if (next >= 90) { setHolding(false); setTimeout(onDone, 250); }
  };
  const onUp = () => setHolding(false);
  const pct = (angle / 90) * 100;
  return (
    <div>
      <div className="mx-auto relative" style={{ width: 140, height: 140 }}>
        <div
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          className="absolute inset-0 rounded-full bg-gradient-to-br from-amber-300/80 to-amber-700/80 shadow-inner cursor-grab active:cursor-grabbing touch-none"
          style={{ transform: `rotate(${angle}deg)`, transition: holding ? undefined : "transform 200ms ease-out" }}
        >
          <div className="absolute left-1/2 top-2 h-6 w-1.5 -translate-x-1/2 rounded bg-black/60" />
        </div>
      </div>
      <div className="mt-4 h-2 w-full overflow-hidden rounded bg-white/10">
        <div className="h-full bg-[color:var(--color-glow)]" style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 text-xs opacity-60">Grab and turn a quarter clockwise</div>
    </div>
  );
}

function TapMini({ target, onDone }: { target: number; onDone: () => void }) {
  const [count, setCount] = useState(0);
  const [pos, setPos] = useState({ x: 50, y: 50 });
  const hit = () => {
    const next = count + 1;
    setCount(next);
    if (next >= target) { setTimeout(onDone, 200); return; }
    setPos({ x: 15 + Math.random() * 70, y: 20 + Math.random() * 60 });
  };
  return (
    <div>
      <div className="relative mx-auto rounded bg-gradient-to-b from-sky-900/40 to-sky-700/30 border border-white/10" style={{ width: "100%", height: 160 }}>
        <button
          onClick={hit}
          aria-label="splash"
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full bg-sky-200/80 hover:bg-white marker-glow animate-[pulse-soft_1.2s_ease-in-out_infinite]"
          style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: 44, height: 44 }}
        />
      </div>
      <div className="mt-3 h-2 w-full overflow-hidden rounded bg-white/10">
        <div className="h-full bg-[color:var(--color-glow)]" style={{ width: `${(count / target) * 100}%` }} />
      </div>
      <div className="mt-1 text-xs opacity-60">{count}/{target} handfuls</div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Onboarding & Breathe overlays                                       */
/* ------------------------------------------------------------------ */

function OnboardingOverlay({ onDone }: { onDone: () => void }) {
  const steps = [
    { title: "Look around", body: "Move your cursor across the scene. Painterly leaves shift gently — you're inside the room." },
    { title: "Inspect an object", body: "Glowing markers (◎) show what you can touch. Press and hold at the center to inspect. Faded (·) means you've already looked." },
    { title: "Steady the morning", body: "Rushed choices smear the world. Hold B to breathe and let it settle. Press H for help, M for the Memory Book, N for a soft hint." },
  ];
  const [i, setI] = useState(0);
  const s = steps[i];
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 backdrop-blur-sm animate-[fade-in_0.3s_ease-out] p-6">
      <div className="vn-panel rounded-lg px-6 py-6 w-[min(92vw,500px)] text-center">
        <div className="font-hand text-[color:var(--color-glow)] text-xl">welcome</div>
        <h3 className="font-serif text-2xl mt-1">{s.title}</h3>
        <p className="mt-3 font-serif text-[15px] leading-snug opacity-85">{s.body}</p>
        <div className="mt-5 flex items-center justify-between">
          <span className="text-xs opacity-50">{i + 1} / {steps.length}</span>
          <div className="flex gap-2">
            <button onClick={onDone} className="choice-btn rounded px-3 py-1 text-xs opacity-70">Skip</button>
            {i < steps.length - 1 ? (
              <button onClick={() => setI(i + 1)} className="choice-btn rounded px-4 py-1.5 text-sm">Next</button>
            ) : (
              <button onClick={onDone} className="choice-btn rounded px-4 py-1.5 text-sm">Begin the morning</button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function BreatheOverlay({ phase }: { phase: "in" | "out" }) {
  return (
    <div className="fixed inset-0 z-[55] pointer-events-none flex items-center justify-center">
      <div
        className="rounded-full border-2 border-[color:var(--color-glow)]/40"
        style={{
          width: phase === "in" ? 260 : 120,
          height: phase === "in" ? 260 : 120,
          transition: "all 3600ms ease-in-out",
          background: "radial-gradient(circle, rgba(255,230,170,0.18), transparent 70%)",
        }}
      />
      <div className="absolute bottom-24 font-hand text-2xl text-[color:var(--color-glow)]/90">
        {phase === "in" ? "inhale…" : "exhale…"}
      </div>
    </div>
  );
}
