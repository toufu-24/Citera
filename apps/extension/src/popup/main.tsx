import React from "react";
import ReactDOM from "react-dom/client";

import { Popup } from "./Popup";
import "../styles.css";

const root = document.getElementById("root");
if (root == null) throw new Error("Popup root element is missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Popup />
  </React.StrictMode>,
);
