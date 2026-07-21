/**
 * tools/enroll.mjs — enroll tool.
 */

import os from "node:os";
import { ensureIdentity, recordEnrollment } from "../identity/keystore.mjs";
import { ENROLL_OUTPUT, ANNOTATIONS } from "./_schemas.mjs";

const TERMS_VERSION = "2026-07-21";
const PRIVACY_VERSION = "2026-07-21";

export const TOOL_DEF = {
  name: "enroll",
  description:
    'Bind THIS device to your SigRank operator so your signed token runs cascade to the live board. Paste the key from signalaf.com → Settings → "New key" (or "Generate connect code"). On first run it generates + stores a local ed25519 keypair (~/.sigrank-mcp/identity.json); only the PUBLIC key is ever sent. By enrolling you agree to the SignalAF Terms of Service (signalaf.com/terms) and Privacy Policy (signalaf.com/privacy). Need a new key? Click "New key" at signalaf.com → Settings, then paste it here.',
  annotations: {
    title: "Enroll device identity",
    ...ANNOTATIONS.destructiveHint,
    ...ANNOTATIONS.idempotentHint,
    ...ANNOTATIONS.openWorldHint,
  },
  inputSchema: {
    type: "object",
    properties: {
      code: {
        type: "string",
        description:
          "the key / connect code (SIGR-XXXXX-XXXXX-XXXXX) from Settings → New key (or Generate connect code)",
      },
      device_label: {
        type: "string",
        description:
          "optional label for this device (default: hostname · agent version)",
      },
    },
    required: ["code"],
  },
  outputSchema: ENROLL_OUTPUT,
};

export async function handleEnroll(args, ctx) {
  // Redeem a web connect code → bind this device. Generates/loads the local keypair;
  // sends ONLY the public key. operator binding happens server-side from the code row.
  const code = String(args?.code || "").trim();
  if (!code)
    throw new Error(
      "enroll requires a `code` — paste your connect code from signalaf.com → Settings → Connect a device.",
    );
  const id = ctx.opts.identity || ensureIdentity();
  const deviceLabel = String(
    args?.device_label || `${os.hostname()} · ${id.agent_version}`,
  ).slice(0, 120);
  const res = await ctx.doFetch(`${ctx.apiBase}/api/v1/devices/enroll`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      code,
      device_id: id.device_id,
      public_key: id.public_key,
      device_label: deviceLabel,
      agent_version: id.agent_version,
      consent_acknowledged: true,
      terms_version: TERMS_VERSION,
      privacy_version: PRIVACY_VERSION,
    }),
  });
  let ack;
  try {
    ack = await res.json();
  } catch {
    ack = {};
  }
  if (res.status === 201 && ack.status === "enrolled") {
    // Persist the binding locally (skipped when a test injects opts.identity → no keystore write).
    if (!ctx.opts.identity)
      recordEnrollment({
        codename: ack.codename,
        operator_id: ack.operator_id,
      });
    return {
      status: "enrolled",
      codename: ack.codename ?? null,
      operator_id: ack.operator_id ?? null,
      device_id: id.device_id,
      trust_status: ack.trust_status ?? "trusted",
    };
  }
  // Recovery: if the server says device_already_enrolled but includes the
  // codename/operator_id, the device IS bound server-side — record it locally
  // and return enrolled instead of erroring. This handles the case where the
  // local binding was lost (partial write, version transition) but the device
  // is still enrolled server-side.
  if (
    ack.reason === "device_already_enrolled" &&
    ack.codename &&
    ack.operator_id
  ) {
    if (!ctx.opts.identity)
      recordEnrollment({
        codename: ack.codename,
        operator_id: ack.operator_id,
      });
    return {
      status: "enrolled",
      codename: ack.codename,
      operator_id: ack.operator_id,
      device_id: id.device_id,
      trust_status: ack.trust_status ?? "trusted",
      recovered: true,
    };
  }
  return {
    status: "error",
    httpStatus: res.status,
    reason: ack.reason || ack.status || `http_${res.status}`,
    detail: ack.detail ?? null,
  };
}
