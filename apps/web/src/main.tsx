
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import { applyPacingCssVars } from "./app/lib/walkthrough/pacing.ts";
  import "./styles/index.css";

  // Once, at the single mount point: mirror the JS pacing constants into CSS
  // vars so keyframe durations stay in lockstep with the JS teardown timers.
  applyPacingCssVars();

  createRoot(document.getElementById("root")!).render(<App />);
