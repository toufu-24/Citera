import { readFileSync } from "node:fs";

function readJson(path) {
  const input = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  let withoutComments = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    const next = input[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        withoutComments += character;
      } else {
        withoutComments += " ";
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        withoutComments += "  ";
        index += 1;
      } else {
        withoutComments += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (!inString && character === "/" && next === "/") {
      lineComment = true;
      withoutComments += "  ";
      index += 1;
      continue;
    }
    if (!inString && character === "/" && next === "*") {
      blockComment = true;
      withoutComments += "  ";
      index += 1;
      continue;
    }
    withoutComments += character;
    if (inString && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === '"' && !escaped) inString = !inString;
    escaped = false;
  }

  let json = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index += 1) {
    const character = withoutComments[index];
    if (!inString && character === ",") {
      let cursor = index + 1;
      while (/\s/u.test(withoutComments[cursor] ?? "")) cursor += 1;
      if (withoutComments[cursor] === "}" || withoutComments[cursor] === "]") continue;
    }
    json += character;
    if (inString && character === "\\" && !escaped) {
      escaped = true;
      continue;
    }
    if (character === '"' && !escaped) inString = !inString;
    escaped = false;
  }
  return JSON.parse(json);
}

function fail(message) {
  console.error(`Citera production preflight failed: ${message}`);
  process.exitCode = 1;
}

const api = readJson("wrangler.jsonc");
const jobs = readJson("workers/jobs/wrangler.jsonc");
const cors = readJson("r2-cors.json");
const production = api.env?.production;
const jobsProduction = jobs.env?.production;
const d1Id = production?.d1_databases?.[0]?.database_id;
const jobsD1Id = jobsProduction?.d1_databases?.[0]?.database_id;
const vars = production?.vars ?? {};
const allowedOrigins = String(vars.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (!production) fail("wrangler.jsonc has no production environment");
if (production?.workers_dev !== false) fail("production workers_dev must be false");
if (jobsProduction?.workers_dev !== false) fail("Jobs production workers_dev must be false");
if (!d1Id || d1Id === "00000000-0000-0000-0000-000000000000") {
  fail("replace the production D1 database_id in wrangler.jsonc");
}
if (jobsD1Id !== d1Id) fail("API and Jobs production D1 database_id values must match");
if (!String(vars.APP_ORIGIN ?? "").startsWith("https://")) {
  fail("APP_ORIGIN must be an HTTPS origin");
}
if (String(vars.APP_ORIGIN).includes("example.com")) fail("replace the APP_ORIGIN placeholder");
let appOrigin;
try {
  appOrigin = new URL(String(vars.APP_ORIGIN));
} catch {
  fail("APP_ORIGIN must be a valid absolute URL");
}
if (
  !appOrigin ||
  appOrigin.protocol !== "https:" ||
  appOrigin.pathname !== "/" ||
  appOrigin.search !== "" ||
  appOrigin.hash !== ""
) {
  fail("APP_ORIGIN must be an HTTPS origin without a path, query, or fragment");
}
const accessTeamDomain = String(vars.ACCESS_TEAM_DOMAIN ?? "").trim();
if (
  !accessTeamDomain ||
  accessTeamDomain.includes("replace-with") ||
  accessTeamDomain.includes("example.com") ||
  accessTeamDomain.startsWith("http://") ||
  !accessTeamDomain.includes(".")
) {
  fail("replace ACCESS_TEAM_DOMAIN with the Cloudflare Access team domain");
}
if (!vars.ACCESS_AUDIENCE || String(vars.ACCESS_AUDIENCE).includes("replace-with")) {
  fail("replace ACCESS_AUDIENCE with the Cloudflare Access application audience");
}
if (!/^[0-9a-f]{32}$/iu.test(String(vars.R2_ACCOUNT_ID ?? ""))) {
  fail("replace R2_ACCOUNT_ID with the 32-character Cloudflare account ID");
}
if (!vars.ALLOWED_EXTENSION_IDS || String(vars.ALLOWED_EXTENSION_IDS).includes("replace-with")) {
  fail("replace ALLOWED_EXTENSION_IDS with the packaged extension ID");
}
if (
  allowedOrigins.length < 2 ||
  allowedOrigins.some(
    (origin) =>
      origin.includes("replace-with") ||
      origin.includes("example.com") ||
      origin.startsWith("http://"),
  )
) {
  fail("ALLOWED_ORIGINS must contain only final HTTPS Web and chrome-extension origins");
}
if (vars.AUTH_DEV_BYPASS !== "false") fail("AUTH_DEV_BYPASS must be false");

const corsOrigins = Array.isArray(cors)
  ? cors.flatMap((rule) => (Array.isArray(rule.AllowedOrigins) ? rule.AllowedOrigins : []))
  : [];
if (
  corsOrigins.length < 2 ||
  corsOrigins.some(
    (origin) =>
      typeof origin !== "string" ||
      origin.includes("replace-with") ||
      origin.includes("example.com") ||
      origin.startsWith("http://"),
  )
) {
  fail("replace every r2-cors.json origin with final production Web/extension origins");
}

if (process.exitCode) process.exit(process.exitCode);
console.log("Citera production configuration preflight passed.");
