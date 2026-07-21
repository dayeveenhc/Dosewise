
  import { createRoot } from "react-dom/client";
  import App from "./app/App.tsx";
  import { ScenarioWalkthroughPage } from "./app/screens/walkthrough/ScenarioWalkthroughPage.tsx";
  import { ScenarioWalkthroughPage2 } from "./app/screens/walkthrough2/ScenarioWalkthroughPage2.tsx";
  import "./styles/index.css";

  // Separate, self-contained demo pages — kept out of the main mockup's own
  // routing (App.tsx has none) via a plain pathname check. /walkthrough2 is
  // checked first since /walkthrough is a prefix of it.
  const path = window.location.pathname;
  const isWalkthrough2 = path.startsWith("/walkthrough2");
  const isWalkthrough = !isWalkthrough2 && path.startsWith("/walkthrough");

  createRoot(document.getElementById("root")!).render(
    isWalkthrough2 ? <ScenarioWalkthroughPage2 /> : isWalkthrough ? <ScenarioWalkthroughPage /> : <App />
  );
