import React from "react";
import ReactDOM from "react-dom/client";

import { Options } from "./Options";
import "../styles.css";

const root = document.getElementById("root");
if (root == null) throw new Error("Options root element is missing");

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <Options />
  </React.StrictMode>,
);
