import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import Sortscope from "../app/page";
import "../app/globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Sortscope could not find its application root.");
}

createRoot(root).render(
  <StrictMode>
    <Sortscope />
  </StrictMode>,
);
