export async function onRequest(context) {
  const { request, env } = context || err}`, 500);  const { request, env } = context;
  }
}

async function fetchAllProxies(env) {
  const apiBase = env.ZENPROXY_BASE.replace(/\/$/, "");
  const url = new URL(apiBase + "/api/proxies");

  url.searchParams.set("api_key", env.ZENPROXY_API_KEY);

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: "Bearer " + env.ZENPROXY_API_KEY,
    },
  });

  if (!res.ok) {
    throw new Error(`/api/proxies failed: HTTP ${res.status}`);
  }

  const data = await res.json();

  const list =
    data.proxies ||
    data.data ||
    data.items ||
    data.results ||
    [];

  if (!Array.isArray(list)) {
    throw new Error("Cannot parse proxy list from /api/proxies");
  }

  return list;
}

async function fetchDetailedProxies(env, filtered) {
  const result = [];
  const concurrency = Number(env.FETCH_CONCURRENCY || "10");
  const apiBase = env.ZENPROXY_BASE.replace(/\/$/, "");

  for (let i = 0; i < filtered.length; i += concurrency) {
    const batch = filtered.slice(i, i + concurrency);

    const items = await Promise.all(
      batch.map(async (meta) => {
        const id = meta.id || meta.proxy_id;
        if (!id) return null;

        const url = new URL(apiBase + "/api/client/fetch");
        url.searchParams.set("api_key", env.ZENPROXY_API_KEY);
        url.searchParams.set("proxy_id", id);

        const res = await fetch(url.toString(), {
          headers: {
            Authorization: "Bearer " + env.ZENPROXY_API_KEY,
          },
        });

        if (!res.ok) return null;

        const data = await res.json();
        const p = data.proxies && data.proxies[0];
        if (!p) return null;

        p.status = meta.status || p.status;
        p.original_name = meta.name || p.name || id;
        p.quality = {
          ...(p.quality || {}),
          ...(meta.quality || {}),
        };

        return p;
      })
    );

    for (const item of items) {
      if (item) result.push(item);
    }
  }

  return result;
}

// 节点名：原名称-国家-IP类型-GPT状态-风险分
function renameProxy(p) {
  const q = p.quality || {};

  const original = cleanName(p.original_name || p.name || p.id || "Proxy");
  const country = cleanName(q.country || p.country || "未知国家");

  const ipType = cleanName(
    q.ip_type ||
      q.ipType ||
      q.network_type ||
      q.asn_type ||
      q.type ||
      (q.is_residential ? "住宅IP" : "未知IP")
  );

  const gptOk =
    q.chatgpt === true ||
    q.chatgpt_accessible === true ||
    q.openai === true;

  const gpt = gptOk ? "GPT可用" : "GPT不可用";

  const risk = getRiskScore(q);
  const riskText = risk === null ? "未知风险" : String(Math.round(risk));

  return `${original}-${country}-${ipType}-${gpt}-${riskText}`;
}

function getRiskScore(q) {
  if (!q) return null;

  if (q.risk_score !== undefined && q.risk_score !== null) {
    const n = Number(q.risk_score);
    return Number.isFinite(n) ? n : null;
  }

  if (q.risk !== undefined && q.risk !== null) {
    const n = Number(q.risk);
    return Number.isFinite(n) ? n : null;
  }

  return null;
}

function cleanName(s) {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/[|,{}[\]]/g, "")
    .trim();
}

function toClashYaml(proxies) {
  const proxyBlocks = [];
  const names = [];

  for (const p of proxies) {
    const o = p.outbound || {};
    const name = renameProxy(p);

    const type = String(o.type || p.type || p.proxy_type || "").toLowerCase();
    const server = o.server || p.server;
    const port = o.server_port || o.port || p.port;

    if (!type || !server || !port) continue;

    const clash = convertOutboundToClash({
      name,
      type,
      server,
      port,
      outbound: o,
    });

    if (!clash) continue;

    proxyBlocks.push(clash);
    names.push(name);
  }

  const lines = [];

  lines.push("mixed-port: 7890");
  lines.push("allow-lan: false");
  lines.push("mode: rule");
  lines.push("log-level: info");
  lines.push("ipv6: true");
  lines.push("");
  lines.push("proxies:");

  for (const p of proxyBlocks) {
    lines.push(`  - ${yamlInline(p)}`);
  }

  lines.push("");
  lines.push("proxy-groups:");

  lines.push("  - name: 节点选择");
  lines.push("    type: select");
  lines.push("    proxies:");
  for (const name of names) {
    lines.push(`      - ${quote(name)}`);
  }

  lines.push("");
  lines.push("  - name: 自动选择");
  lines.push("    type: url-test");
  lines.push("    url: https://www.gstatic.com/generate_204");
  lines.push("    interval: 300");
  lines.push("    tolerance: 50");
  lines.push("    proxies:");
  for (const name of names) {
    lines.push(`      - ${quote(name)}`);
  }

  lines.push("");
  lines.push("rules:");
  lines.push("  - MATCH,节点选择");

  return lines.join("\n");
}

function convertOutboundToClash({ name, type, server, port, outbound }) {
  if (type === "vless") {
    const obj = {
      name,
      type: "vless",
      server,
      port,
      uuid: outbound.uuid,
      network: outbound.transport?.type || outbound.network || "tcp",
      tls: !!outbound.tls?.enabled,
      servername: outbound.tls?.server_name || outbound.server_name,
      flow: outbound.flow,
      "skip-cert-verify": true,
    };

    applyTransport(obj, outbound);
    return obj;
  }

  if (type === "vmess") {
    const obj = {
      name,
      type: "vmess",
      server,
      port,
      uuid: outbound.uuid,
      alterId: outbound.alter_id || outbound.alterId || 0,
      cipher: outbound.security || "auto",
      network: outbound.transport?.type || outbound.network || "tcp",
      tls: !!outbound.tls?.enabled,
      servername: outbound.tls?.server_name || outbound.server_name,
      "skip-cert-verify": true,
    };

    applyTransport(obj, outbound);
    return obj;
  }

  if (type === "trojan") {
    const obj = {
      name,
      type: "trojan",
      server,
      port,
      password: outbound.password,
      sni: outbound.tls?.server_name || outbound.server_name,
      "skip-cert-verify": true,
    };

    applyTransport(obj, outbound);
    return obj;
  }

  if (type === "shadowsocks" || type === "ss") {
    return {
      name,
      type: "ss",
      server,
      port,
      cipher: outbound.method,
      password: outbound.password,
    };
  }

  if (type === "hysteria2" || type === "hy2") {
    return {
      name,
      type: "hysteria2",
      server,
      port,
      password: outbound.password,
      sni: outbound.tls?.server_name || outbound.server_name,
      "skip-cert-verify": true,
    };
  }

  if (type === "socks" || type === "socks5") {
    const obj = {
      name,
      type: "socks5",
      server,
      port,
    };

    if (outbound.username) obj.username = outbound.username;
    if (outbound.password) obj.password = outbound.password;

    return obj;
  }

  if (type === "http" || type === "https") {
    const obj = {
      name,
      type: "http",
      server,
      port,
      tls: type === "https" || !!outbound.tls?.enabled,
    };

    if (outbound.username) obj.username = outbound.username;
    if (outbound.password) obj.password = outbound.password;

    return obj;
  }

  return null;
}

function applyTransport(obj, outbound) {
  const t = outbound.transport || {};
  const type = t.type || outbound.network;

  if (!type) return;

  if (type === "ws" || type === "websocket") {
    obj.network = "ws";
    obj["ws-opts"] = {
      path: t.path || outbound.path || "/",
      headers: t.headers || {},
    };

    if (t.host || outbound.host) {
      obj["ws-opts"].headers.Host = t.host || outbound.host;
    }
  }

  if (type === "grpc") {
    obj.network = "grpc";
    obj["grpc-opts"] = {
      "grpc-service-name": t.service_name || outbound.service_name || "",
    };
  }
}

function toV2rayUri(p) {
  const o = p.outbound || {};
  const name = encodeURIComponent(renameProxy(p));

  const type = String(o.type || p.type || p.proxy_type || "").toLowerCase();
  const server = o.server || p.server;
  const port = o.server_port || o.port || p.port;

  if (!type || !server || !port) return null;

  if (type === "vless") {
    const uuid = o.uuid;
    const security = o.tls?.enabled ? "tls" : "none";
    const sni = o.tls?.server_name || o.server_name || "";

    return `vless://${uuid}@${server}:${port}?encryption=none&security=${security}&sni=${encodeURIComponent(
      sni
    )}#${name}`;
  }

  if (type === "trojan") {
    const password = encodeURIComponent(o.password || "");
    const sni = o.tls?.server_name || o.server_name || "";

    return `trojan://${password}@${server}:${port}?security=tls&sni=${encodeURIComponent(
      sni
    )}#${name}`;
  }

  if (type === "shadowsocks" || type === "ss") {
    const userInfo = btoa(`${o.method}:${o.password}`);
    return `ss://${userInfo}@${server}:${port}#${name}`;
  }

  return null;
}

function yamlInline(obj) {
  const parts = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;

    if (typeof v === "boolean" || typeof v === "number") {
      parts.push(`${k}: ${v}`);
    } else if (typeof v === "object") {
      parts.push(`${k}: ${yamlObject(v)}`);
    } else {
      parts.push(`${k}: ${quote(String(v))}`);
    }
  }

  return `{ ${parts.join(", ")} }`;
}

function yamlObject(obj) {
  const parts = [];

  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === "") continue;

    if (typeof v === "object") {
      parts.push(`${k}: ${yamlObject(v)}`);
    } else if (typeof v === "boolean" || typeof v === "number") {
      parts.push(`${k}: ${v}`);
    } else {
      parts.push(`${k}: ${quote(String(v))}`);
    }
  }

  return `{ ${parts.join(", ")} }`;
}

function quote(s) {
  return JSON.stringify(String(s));
}

function base64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = "";

  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }

  return btoa(binary);
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
  });
}
  const url = new URL(request.url);

  const target = (url.searchParams.get("target") || "clash").toLowerCase();
  const count = Number(url.searchParams.get("count") || "200");

  const statusFilter = (url.searchParams.get("status") || "valid").toLowerCase();
  const qualityFilter = (url.searchParams.get("quality") || "chatgpt").toLowerCase();

  const countryFilter = url.searchParams.get("country");
  const typeFilter = url.searchParams.get("type");
  const riskMax = url.searchParams.get("risk_max")
    ? Number(url.searchParams.get("risk_max"))
    : null;

  if (!env.ZENPROXY_BASE || !env.ZENPROXY_API_KEY) {
    return text("Missing ZENPROXY_BASE or ZENPROXY_API_KEY", 500);
  }

  try {
    const all = await fetchAllProxies(env);

    let filtered = all.filter((p) => {
      const status = String(p.status || "").toLowerCase();
      const q = p.quality || {};

      const chatgptOk =
        q.chatgpt === true ||
        q.chatgpt_accessible === true ||
        q.openai === true;

      const country = q.country || p.country;
      const type = p.type || p.proxy_type;
      const risk = getRiskScore(q);

      if (statusFilter === "valid" && status !== "valid") return false;
      if (qualityFilter === "chatgpt" && !chatgptOk) return false;

      if (
        countryFilter &&
        String(country || "").toUpperCase() !== countryFilter.toUpperCase()
      ) {
        return false;
      }

      if (
        typeFilter &&
        String(type || "").toLowerCase() !== typeFilter.toLowerCase()
      ) {
        return false;
      }

      if (riskMax !== null && risk !== null && risk > riskMax) {
        return false;
      }

      return true;
    });

    filtered = filtered.slice(0, count);

    if (!filtered.length) {
      return text("No proxies matched: status=valid and quality=chatgpt", 404);
    }

    const detailed = await fetchDetailedProxies(env, filtered);

    if (!detailed.length) {
      return text("No detailed proxies fetched from /api/client/fetch", 404);
    }

    if (target === "v2ray" || target === "base64") {
      const lines = detailed.map(toV2rayUri).filter(Boolean);

      return new Response(base64Utf8(lines.join("\n")), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "profile-update-interval": "6",
        },
      });
    }

    return new Response(toClashYaml(detailed), {
      headers: {
        "content-type": "text/yaml; charset=utf-8",
        "profile-update-interval": "6",
      },
    });
  } catch (err) {
