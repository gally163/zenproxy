export async function onRequest(context) {
  var;  var request = context.request;
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

    var detailed = await fetchDetailedProxies(env, filtered);

    if (!detailed.length) {
      return text("No detailed proxies fetched from /api/client/fetch", 404);
    }

    if (target === "v2ray" || target === "base64") {
      var lines = detailed.map(toV2rayUri).filter(Boolean);
      return new Response(base64Utf8(lines.join("\n")), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "profile-update-interval": "6"
        }
      });
    }

    var yaml = toClashYaml(detailed);

    return new Response(yaml, {
      headers: {
        "content-type": "text/yaml; charset=utf-8",
        "profile-update-interval": "6"
      }
    });
  } catch (err) {
    return text("Error: " + (err.message || err), 500);
  }
}

async function fetchAllProxies(env) {
  var apiBase = env.ZENPROXY_BASE.replace(/\/$/, "");
  var url = new URL(apiBase + "/api/proxies");

  url.searchParams.set("api_key", env.ZENPROXY_API_KEY);

  var res = await fetch(url.toString(), {
    headers: {
      Authorization: "Bearer " + env.ZENPROXY_API_KEY
    }
  });

  if (!res.ok) {
    throw new Error("/api/proxies failed: HTTP " + res.status);
  }

  var data = await res.json();

  var list =
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
  var result = [];
  var concurrency = Number(env.FETCH_CONCURRENCY || "10");
  var apiBase = env.ZENPROXY_BASE.replace(/\/$/, "");

  for (var i = 0; i < filtered.length; i += concurrency) {
    var batch = filtered.slice(i, i + concurrency);

    var items = await Promise.all(
      batch.map(async function (meta) {
        var id = meta.id || meta.proxy_id;
        if (!id) return null;

        var url = new URL(apiBase + "/api/client/fetch");
        url.searchParams.set("api_key", env.ZENPROXY_API_KEY);
        url.searchParams.set("proxy_id", id);

        var res = await fetch(url.toString(), {
          headers: {
            Authorization: "Bearer " + env.ZENPROXY_API_KEY
          }
        });

        if (!res.ok) return null;

        var data = await res.json();
        var p = data.proxies && data.proxies[0];
        if (!p) return null;

        p.status = meta.status || p.status;
        p.original_name = meta.name || p.name || id;
        p.quality = Object.assign({}, p.quality || {}, meta.quality || {});

        return p;
      })
    );

    for (var j = 0; j < items.length; j++) {
      if (items[j]) result.push(items[j]);
    }
  }

  return result;
}

function renameProxy(p) {
  var q = p.quality || {};

  var original = cleanName(p.original_name || p.name || p.id || "Proxy");
  var country = cleanName(q.country || p.country || "未知国家");

  var ipType = cleanName(
    q.ip_type ||
      q.ipType ||
      q.network_type ||
      q.asn_type ||
      q.type ||
      (q.is_residential ? "住宅IP" : "未知IP")
  );

  var gptOk =
    q.chatgpt === true ||
    q.chatgpt_accessible === true ||
    q.openai === true;

  var gpt = gptOk ? "GPT可用" : "GPT不可用";

  var risk = getRiskScore(q);
  var riskText = risk === null ? "未知风险" : String(Math.round(risk));

  return original + "-" + country + "-" + ipType + "-" + gpt + "-" + riskText;
}

function getRiskScore(q) {
  if (!q) return null;

  if (q.risk_score !== undefined && q.risk_score !== null) {
    var n1 = Number(q.risk_score);
    return Number.isFinite(n1) ? n1 : null;
  }

  if (q.risk !== undefined && q.risk !== null) {
    var n2 = Number(q.risk);
    return Number.isFinite(n2) ? n2 : null;
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
  var proxyBlocks = [];
  var names = [];

  for (var i = 0; i < proxies.length; i++) {
    var p = proxies[i];
    var o = p.outbound || {};
    var name = renameProxy(p);

    var type = String(o.type || p.type || p.proxy_type || "").toLowerCase();
    var server = o.server || p.server;
    var port = o.server_port || o.port || p.port;

    if (!type || !server || !port) continue;

    var clash = convertOutboundToClash({
      name: name,
      type: type,
      server: server,
      port: port,
      outbound: o
    });

    if (!clash) continue;

    proxyBlocks.push(clash);
    names.push(name);
  }

  var lines = [];

  lines.push("mixed-port: 7890");
  lines.push("allow-lan: false");
  lines.push("mode: rule");
  lines.push("log-level: info");
  lines.push("ipv6: true");
  lines.push("");
  lines.push("proxies:");

  for (var a = 0; a < proxyBlocks.length; a++) {
    lines.push("  - " + yamlInline(proxyBlocks[a]));
  }

  lines.push("");
  lines.push("proxy-groups:");

  lines.push("  - name: 节点选择");
  lines.push("    type: select");
  lines.push("    proxies:");
  for (var b = 0; b < names.length; b++) {
    lines.push("      - " + quote(names[b]));
  }

  lines.push("");
  lines.push("  - name: 自动选择");
  lines.push("    type: url-test");
  lines.push("    url: https://www.gstatic.com/generate_204");
  lines.push("    interval: 300");
  lines.push("    tolerance: 50");
  lines.push("    proxies:");
  for (var c = 0; c < names.length; c++) {
    lines.push("      - " + quote(names[c]));
  }

  lines.push("");
  lines.push("rules:");
  lines.push("  - MATCH,节点选择");

  return lines.join("\n");
}

function convertOutboundToClash(input) {
  var name = input.name;
  var type = input.type;
  var server = input.server;
  var port = input.port;
  var outbound = input.outbound || {};

  if (type === "vless") {
    var obj1 = {
      name: name,
      type: "vless",
      server: server,
      port: port,
      uuid: outbound.uuid,
      network: getTransportType(outbound),
      tls: !!(outbound.tls && outbound.tls.enabled),
      servername: getTlsServerName(outbound),
      flow: outbound.flow,
      "skip-cert-verify": true
    };

    applyTransport(obj1, outbound);
    return obj1;
  }

  if (type === "vmess") {
    var obj2 = {
      name: name,
      type: "vmess",
      server: server,
      port: port,
      uuid: outbound.uuid,
      alterId: outbound.alter_id || outbound.alterId || 0,
      cipher: outbound.security || "auto",
      network: getTransportType(outbound),
      tls: !!(outbound.tls && outbound.tls.enabled),
      servername: getTlsServerName(outbound),
      "skip-cert-verify": true
    };

    applyTransport(obj2, outbound);
    return obj2;
  }

  if (type === "trojan") {
    var obj3 = {
      name: name,
      type: "trojan",
      server: server,
      port: port,
      password: outbound.password,
      sni: getTlsServerName(outbound),
      "skip-cert-verify": true
    };

    applyTransport(obj3, outbound);
    return obj3;
  }

  if (type === "shadowsocks" || type === "ss") {
    return {
      name: name,
      type: "ss",
      server: server,
      port: port,
      cipher: outbound.method,
      password: outbound.password
    };
  }

  if (type === "hysteria2" || type === "hy2") {
    return {
      name: name,
      type: "hysteria2",
      server: server,
      port: port,
      password: outbound.password,
      sni: getTlsServerName(outbound),
      "skip-cert-verify": true
    };
  }

  if (type === "socks" || type === "socks5") {
    var obj4 = {
      name: name,
      type: "socks5",
      server: server,
      port: port
    };

    if (outbound.username) obj4.username = outbound.username;
    if (outbound.password) obj4.password = outbound.password;

    return obj4;
  }

  if (type === "http" || type === "https") {
    var obj5 = {
      name: name,
      type: "http",
      server: server,
      port: port,
      tls: type === "https" || !!(outbound.tls && outbound.tls.enabled)
    };

    if (outbound.username) obj5.username = outbound.username;
    if (outbound.password) obj5.password = outbound.password;

    return obj5;
  }

  return null;
}

function getTransportType(outbound) {
  if (outbound.transport && outbound.transport.type) {
    if (outbound.transport.type === "websocket") return "ws";
    return outbound.transport.type;
  }

  return outbound.network || "tcp";
}

function getTlsServerName(outbound) {
  if (outbound.tls && outbound.tls.server_name) return outbound.tls.server_name;
  return outbound.server_name || "";
}

function applyTransport(obj, outbound) {
  var t = outbound.transport || {};
  var type = t.type || outbound.network;

  if (!type) return;

  if (type === "ws" || type === "websocket") {
    obj.network = "ws";
    obj["ws-opts"] = {
      path: t.path || outbound.path || "/",
      headers: t.headers || {}
    };

    if (t.host || outbound.host) {
      obj["ws-opts"].headers.Host = t.host || outbound.host;
    }
  }

  if (type === "grpc") {
    obj.network = "grpc";
    obj["grpc-opts"] = {
      "grpc-service-name": t.service_name || outbound.service_name || ""
    };
  }
}

function toV2rayUri(p) {
  var o = p.outbound || {};
  var name = encodeURIComponent(renameProxy(p));

  var type = String(o.type || p.type || p.proxy_type || "").toLowerCase();
  var server = o.server || p.server;
  var port = o.server_port || o.port || p.port;

  if (!type || !server || !port) return null;

  if (type === "vless") {
    var uuid = o.uuid;
    var security = o.tls && o.tls.enabled ? "tls" : "none";
    var sni = getTlsServerName(o);

    return (
      "vless://" +
      uuid +
      "@" +
      server +
      ":" +
      port +
      "?encryption=none&security=" +
      security +
      "&sni=" +
      encodeURIComponent(sni) +
      "#" +
      name
    );
  }

  if (type === "trojan") {
    var password = encodeURIComponent(o.password || "");
    var sni2 = getTlsServerName(o);

    return (
      "trojan://" +
      password +
      "@" +
      server +
      ":" +
      port +
      "?security=tls&sni=" +
      encodeURIComponent(sni2) +
      "#" +
      name
    );
  }

  if (type === "shadowsocks" || type === "ss") {
    var userInfo = btoa(String(o.method || "") + ":" + String(o.password || ""));
    return "ss://" + userInfo + "@" + server + ":" + port + "#" + name;
  }

  return null;
}

function yamlInline(obj) {
  var parts = [];

  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;

    var v = obj[k];
    if (v === undefined || v === null || v === "") continue;

    if (typeof v === "boolean" || typeof v === "number") {
      parts.push(k + ": " + v);
    } else if (typeof v === "object") {
      parts.push(k + ": " + yamlObject(v));
    } else {
      parts.push(k + ": " + quote(String(v)));
    }
  }

  return "{ " + parts.join(", ") + " }";
}

function yamlObject(obj) {
  var parts = [];

  for (var k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;

    var v = obj[k];
    if (v === undefined || v === null || v === "") continue;

    if (typeof v === "object") {
      parts.push(k + ": " + yamlObject(v));
    } else if (typeof v === "boolean" || typeof v === "number") {
      parts.push(k + ": " + v);
    } else {
      parts.push(k + ": " + quote(String(v)));
    }
  }

  return "{ " + parts.join(", ") + " }";
}

function quote(s) {
  return JSON.stringify(String(s));
}

function base64Utf8(str) {
  var bytes = new TextEncoder().encode(str);
  var binary = "";

  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function text(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}
  var env = context.env;
  var url = new URL(request.url);

  var target = (url.searchParams.get("target") || "clash").toLowerCase();
  var count = Number(url.searchParams.get("count") || "200");

  var statusFilter = (url.searchParams.get("status") || "valid").toLowerCase();
  var qualityFilter = (url.searchParams.get("quality") || "chatgpt").toLowerCase();

  var countryFilter = url.searchParams.get("country");
  var typeFilter = url.searchParams.get("type");
  var riskMax = url.searchParams.get("risk_max")
    ? Number(url.searchParams.get("risk_max"))
    : null;

  if (!env.ZENPROXY_BASE || !env.ZENPROXY_API_KEY) {
    return text("Missing ZENPROXY_BASE or ZENPROXY_API_KEY", 500);
  }

  try {
    var all = await fetchAllProxies(env);

    var filtered = all.filter(function (p) {
      var status = String(p.status || "").toLowerCase();
      var q = p.quality || {};

      var chatgptOk =
        q.chatgpt === true ||
        q.chatgpt_accessible === true ||
        q.openai === true;

      var country = q.country || p.country;
      var type = p.type || p.proxy_type;
      var risk = getRiskScore(q);

