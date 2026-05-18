export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var url = new URL(request.url);

  var target = (url.searchParams.get("target") || "clash").toLowerCase();

  var count = Number(url.searchParams.get("count") || "50");
  if (!Number.isFinite(count) || count <= 0) {
    count = 50;
  }
  count = Math.floor(count);

  var statusFilter = (url.searchParams.get("status") || "any").toLowerCase();
  var qualityFilter = (url.searchParams.get("quality") || "any").toLowerCase();

  var countryFilter = url.searchParams.get("country");
  var typeFilter = url.searchParams.get("type");

  var riskMax = null;
  if (url.searchParams.get("risk_max")) {
    riskMax = Number(url.searchParams.get("risk_max"));
    if (!Number.isFinite(riskMax)) {
      riskMax = null;
    }
  }

  var debug = url.searchParams.get("debug") === "1";

  var scanPages = Number(url.searchParams.get("scan_pages") || "8");
  if (!Number.isFinite(scanPages) || scanPages <= 0) {
    scanPages = 8;
  }
  scanPages = Math.floor(scanPages);

  var perPage = Number(url.searchParams.get("per_page") || "1000");
  if (!Number.isFinite(perPage) || perPage <= 0) {
    perPage = 1000;
  }
  perPage = Math.floor(perPage);

  var maxValidExport = Number(env.MAX_VALID_EXPORT || "40");
  if (!Number.isFinite(maxValidExport) || maxValidExport <= 0) {
    maxValidExport = 40;
  }
  maxValidExport = Math.floor(maxValidExport);

  if (statusFilter === "valid" && count > maxValidExport) {
    count = maxValidExport;
  }

  if (!env.ZENPROXY_BASE || !env.ZENPROXY_API_KEY) {
    return textResponse("Missing ZENPROXY_BASE or ZENPROXY_API_KEY", 500);
  }

  try {
    if (statusFilter !== "valid") {
      var directProxies = await fetchDirectProxies(
        env,
        count,
        qualityFilter,
        countryFilter,
        typeFilter,
        riskMax
      );

      if (debug) {
        return jsonResponse({
          mode: "direct",
          requested_count: count,
          returned_count: directProxies.length,
          quality_filter: qualityFilter,
          country: countryFilter,
          type: typeFilter,
          risk_max: riskMax
        }, 200);
      }

      if (!directProxies.length) {
        return textResponse("No proxies matched direct fetch filters", 404);
      }

      return buildSubscriptionResponse(target, directProxies);
    }

    var scanResult = await collectValidProxyMetas(
      env,
      count,
      qualityFilter,
      countryFilter,
      typeFilter,
      riskMax,
      scanPages,
      perPage
    );

    if (debug) {
      return jsonResponse(scanResult.stats, 200);
    }

    if (!scanResult.metas.length) {
      return textResponse("No proxies matched: status=valid and quality=" + qualityFilter, 404);
    }

    var detailed = await fetchDetailedByIds(env, scanResult.metas);

    if (!detailed.length) {
      return textResponse("Matched proxy IDs found, but no detailed outbound could be fetched", 404);
    }

    return buildSubscriptionResponse(target, detailed);
  } catch (err) {
    return textResponse("Error: " + String(err && err.message ? err.message : err), 500);
  }
}

/* -------------------- 路径 A：status=any 直接拉 /api/client/fetch -------------------- */

async function fetchDirectProxies(env, count, qualityFilter, countryFilter, typeFilter, riskMax) {
  var apiBase = String(env.ZENPROXY_BASE).replace(/\/$/, "");
  var url = new URL(apiBase + "/api/client/fetch");

  url.searchParams.set("api_key", env.ZENPROXY_API_KEY);
  url.searchParams.set("count", String(count));

  if (qualityFilter === "chatgpt") {
    url.searchParams.set("chatgpt", "true");
  }

  if (countryFilter) {
    url.searchParams.set("country", countryFilter);
  }

  if (typeFilter) {
    url.searchParams.set("type", typeFilter);
  }

  if (riskMax !== null) {
    url.searchParams.set("risk_max", String(riskMax));
  }

  var res = await fetch(url.toString(), {
    headers: {
      "Authorization": "Bearer " + env.ZENPROXY_API_KEY
    }
  });

  if (!res.ok) {
    throw new Error("/api/client/fetch failed: HTTP " + res.status);
  }

  var data = await res.json();
  var list = extractProxyList(data);

  for (var i = 0; i < list.length; i++) {
    if (!list[i].original_name) {
      list[i].original_name = list[i].name || list[i].id || "Proxy";
    }
  }

  return list;
}

/* -------------------- 路径 B：status=valid 扫描分页 /api/proxies -------------------- */

async function collectValidProxyMetas(
  env,
  wantedCount,
  qualityFilter,
  countryFilter,
  typeFilter,
  riskMax,
  scanPages,
  perPage
) {
  var apiBase = String(env.ZENPROXY_BASE).replace(/\/$/, "");
  var matched = [];

  var stats = {
    mode: "valid-scan",
    requested_count: wantedCount,
    scan_pages: scanPages,
    per_page: perPage,
    pages_scanned: 0,
    proxies_scanned: 0,
    valid_seen: 0,
    chatgpt_seen: 0,
    valid_and_chatgpt_seen: 0,
    matched_after_filters: 0
  };

  for (var page = 1; page <= scanPages; page++) {
    var url = new URL(apiBase + "/api/proxies");
    url.searchParams.set("api_key", env.ZENPROXY_API_KEY);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));

    var res = await fetch(url.toString(), {
      headers: {
        "Authorization": "Bearer " + env.ZENPROXY_API_KEY
      }
    });

    if (!res.ok) {
      throw new Error("/api/proxies failed: HTTP " + res.status + " on page " + page);
    }

    var data = await res.json();
    var pageList = extractProxyList(data);

    stats.pages_scanned += 1;
    stats.proxies_scanned += pageList.length;

    if (!pageList.length) {
      break;
    }

    for (var i = 0; i < pageList.length; i++) {
      var p = pageList[i];
      var q = p.quality || {};

      var isValid = String(p.status || "").toLowerCase() === "valid";
      var isChatgpt =
        q.chatgpt === true ||
        q.chatgpt_accessible === true ||
        q.openai === true;

      if (isValid) {
        stats.valid_seen += 1;
      }
      if (isChatgpt) {
        stats.chatgpt_seen += 1;
      }
      if (isValid && isChatgpt) {
        stats.valid_and_chatgpt_seen += 1;
      }

      if (!isValid) {
        continue;
      }

      if (qualityFilter === "chatgpt" && !isChatgpt) {
        continue;
      }

      if (countryFilter) {
        var country = String(q.country || p.country || "").toUpperCase();
        if (country !== countryFilter.toUpperCase()) {
          continue;
        }
      }

      if (typeFilter) {
        var proxyType = String(p.type || p.proxy_type || "").toLowerCase();
        if (proxyType !== typeFilter.toLowerCase()) {
          continue;
        }
      }

      if (riskMax !== null) {
        var risk = getRiskScore(q);
        if (risk !== null && risk > riskMax) {
          continue;
        }
      }

      matched.push({
        id: p.id || p.proxy_id,
        name: p.name || "Proxy",
        status: p.status,
        type: p.type || p.proxy_type,
        quality: q,
        server: p.server,
        port: p.port
      });

      if (matched.length >= wantedCount) {
        break;
      }
    }

    if (matched.length >= wantedCount) {
      break;
    }

    if (pageList.length < perPage) {
      break;
    }
  }

  stats.matched_after_filters = matched.length;

  return {
    metas: matched,
    stats: stats
  };
}

async function fetchDetailedByIds(env, metas) {
  var result = [];
  var concurrency = Number(env.FETCH_CONCURRENCY || "8");
  if (!Number.isFinite(concurrency) || concurrency <= 0) {
    concurrency = 8;
  }
  concurrency = Math.floor(concurrency);

  var apiBase = String(env.ZENPROXY_BASE).replace(/\/$/, "");

  for (var i = 0; i < metas.length; i += concurrency) {
    var batch = metas.slice(i, i + concurrency);

    var items = await Promise.all(
      batch.map(async function (meta) {
        if (!meta.id) {
          return null;
        }

        var url = new URL(apiBase + "/api/client/fetch");
        url.searchParams.set("api_key", env.ZENPROXY_API_KEY);
        url.searchParams.set("proxy_id", meta.id);

        var res = await fetch(url.toString(), {
          headers: {
            "Authorization": "Bearer " + env.ZENPROXY_API_KEY
          }
        });

        if (!res.ok) {
          return null;
        }

        var data = await res.json();
        var list = extractProxyList(data);

        if (!list.length) {
          return null;
        }

        var p = list[0];

        p.status = meta.status || p.status;
        p.original_name = meta.name || p.name || meta.id;
        p.type = meta.type || p.type;
        p.quality = mergeObjects(meta.quality || {}, p.quality || {});

        if (!p.server && meta.server) {
          p.server = meta.server;
        }
        if (!p.port && meta.port) {
          p.port = meta.port;
        }

        return p;
      })
    );

    for (var j = 0; j < items.length; j++) {
      if (items[j]) {
        result.push(items[j]);
      }
    }
  }

  return result;
}

/* -------------------- 订阅输出 -------------------- */

function buildSubscriptionResponse(target, proxies) {
  if (target === "v2ray" || target === "base64") {
    var lines = [];

    for (var i = 0; i < proxies.length; i++) {
      var uri = toV2rayUri(proxies[i]);
      if (uri) {
        lines.push(uri);
      }
    }

    if (!lines.length) {
      return textResponse("No nodes could be converted to V2Ray subscription", 404);
    }

    return new Response(base64Utf8(lines.join("\n")), {
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "profile-update-interval": "6"
      }
    });
  }

  var yaml = toClashYaml(proxies);

  if (!yaml) {
    return textResponse("No nodes could be converted to Clash subscription", 404);
  }

  return new Response(yaml, {
    headers: {
      "content-type": "text/yaml; charset=utf-8",
      "profile-update-interval": "6"
    }
  });
}

/* -------------------- 工具函数 -------------------- */

function extractProxyList(data) {
  if (!data) {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  if (Array.isArray(data.proxies)) {
    return data.proxies;
  }

  if (Array.isArray(data.items)) {
    return data.items;
  }

  if (Array.isArray(data.results)) {
    return data.results;
  }

  if (data.data) {
    if (Array.isArray(data.data)) {
      return data.data;
    }
    if (Array.isArray(data.data.proxies)) {
      return data.data.proxies;
    }
    if (Array.isArray(data.data.items)) {
      return data.data.items;
    }
    if (Array.isArray(data.data.results)) {
      return data.data.results;
    }
  }

  if (data.result) {
    if (Array.isArray(data.result.proxies)) {
      return data.result.proxies;
    }
    if (Array.isArray(data.result.items)) {
      return data.result.items;
    }
  }

  return [];
}

function mergeObjects(a, b) {
  var out = {};
  var k;

  for (k in a) {
    if (Object.prototype.hasOwnProperty.call(a, k)) {
      out[k] = a[k];
    }
  }

  for (k in b) {
    if (Object.prototype.hasOwnProperty.call(b, k)) {
      out[k] = b[k];
    }
  }

  return out;
}

function getRiskScore(q) {
  if (!q) {
    return null;
  }

  if (q.risk_score !== undefined && q.risk_score !== null) {
    var n1 = Number(q.risk_score);
    if (Number.isFinite(n1)) {
      return n1;
    }
  }

  if (q.risk !== undefined && q.risk !== null) {
    var n2 = Number(q.risk);
    if (Number.isFinite(n2)) {
      return n2;
    }
  }

  return null;
}

function cleanName(s) {
  return String(s)
    .replace(/\s+/g, " ")
    .replace(/[|,{}[\]]/g, "")
    .trim();
}

/* -------------------- 重命名 -------------------- */

function renameProxy(p) {
  var q = p.quality || {};

  var original = cleanName(p.original_name || p.name || p.id || "Proxy");
  var country = cleanName(q.country || p.country || "未知国家");

  var ipType = q.ip_type ||
    q.ipType ||
    q.network_type ||
    q.asn_type ||
    q.type ||
    "";

  if (!ipType) {
    if (q.is_residential === true) {
      ipType = "住宅IP";
    } else {
      ipType = "未知IP";
    }
  }

  ipType = cleanName(ipType);

  var gptOk =
    q.chatgpt === true ||
    q.chatgpt_accessible === true ||
    q.openai === true;

  var gptText = gptOk ? "GPT可用" : "GPT不可用";

  var risk = getRiskScore(q);
  var riskText = risk === null ? "未知风险" : String(Math.round(risk));

  return original + "-" + country + "-" + ipType + "-" + gptText + "-" + riskText;
}

/* -------------------- Clash YAML -------------------- */

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

    if (!type || !server || !port) {
      continue;
    }

    var clash = convertOutboundToClash(name, type, server, port, o);

    if (!clash) {
      continue;
    }

    proxyBlocks.push(clash);
    names.push(name);
  }

  if (!proxyBlocks.length) {
    return "";
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

function convertOutboundToClash(name, type, server, port, outbound) {
  if (type === "vless") {
    var obj1 = {
      "name": name,
      "type": "vless",
      "server": server,
      "port": Number(port),
      "uuid": outbound.uuid,
      "network": getTransportType(outbound),
      "tls": getTlsEnabled(outbound),
      "servername": getTlsServerName(outbound),
      "flow": outbound.flow,
      "skip-cert-verify": true
    };

    applyTransport(obj1, outbound);
    return obj1;
  }

  if (type === "vmess") {
    var obj2 = {
      "name": name,
      "type": "vmess",
      "server": server,
      "port": Number(port),
      "uuid": outbound.uuid,
      "alterId": outbound.alter_id || outbound.alterId || 0,
      "cipher": outbound.security || "auto",
      "network": getTransportType(outbound),
      "tls": getTlsEnabled(outbound),
      "servername": getTlsServerName(outbound),
      "skip-cert-verify": true
    };

    applyTransport(obj2, outbound);
    return obj2;
  }

  if (type === "trojan") {
    var obj3 = {
      "name": name,
      "type": "trojan",
      "server": server,
      "port": Number(port),
      "password": outbound.password,
      "sni": getTlsServerName(outbound),
      "skip-cert-verify": true
    };

    applyTransport(obj3, outbound);
    return obj3;
  }

  if (type === "shadowsocks" || type === "ss") {
    return {
      "name": name,
      "type": "ss",
      "server": server,
      "port": Number(port),
      "cipher": outbound.method,
      "password": outbound.password
    };
  }

  if (type === "hysteria2" || type === "hy2") {
    return {
      "name": name,
      "type": "hysteria2",
      "server": server,
      "port": Number(port),
      "password": outbound.password,
      "sni": getTlsServerName(outbound),
      "skip-cert-verify": true
    };
  }

  if (type === "socks" || type === "socks5") {
    var obj4 = {
      "name": name,
      "type": "socks5",
      "server": server,
      "port": Number(port)
    };

    if (outbound.username) {
      obj4.username = outbound.username;
    }

    if (outbound.password) {
      obj4.password = outbound.password;
    }

    return obj4;
  }

  if (type === "http" || type === "https") {
    var obj5 = {
      "name": name,
      "type": "http",
      "server": server,
      "port": Number(port),
      "tls": type === "https" || getTlsEnabled(outbound)
    };

    if (outbound.username) {
      obj5.username = outbound.username;
    }

    if (outbound.password) {
      obj5.password = outbound.password;
    }

    return obj5;
  }

  return null;
}

function getTlsEnabled(outbound) {
  if (outbound && outbound.tls && outbound.tls.enabled) {
    return true;
  }
  return false;
}

function getTlsServerName(outbound) {
  if (outbound && outbound.tls && outbound.tls.server_name) {
    return outbound.tls.server_name;
  }
  if (outbound && outbound.server_name) {
    return outbound.server_name;
  }
  return "";
}

function getTransportType(outbound) {
  if (outbound && outbound.transport && outbound.transport.type) {
    if (outbound.transport.type === "websocket") {
      return "ws";
    }
    return outbound.transport.type;
  }
  if (outbound && outbound.network) {
    return outbound.network;
  }
  return "tcp";
}

function applyTransport(obj, outbound) {
  var t = outbound.transport || {};
  var type = t.type || outbound.network || "";

  if (type === "websocket") {
    type = "ws";
  }

  if (type === "ws") {
    obj.network = "ws";

    var wsOpts = {
      "path": t.path || outbound.path || "/",
      "headers": {}
    };

    if (t.headers) {
      wsOpts.headers = t.headers;
    }

    if (t.host || outbound.host) {
      wsOpts.headers.Host = t.host || outbound.host;
    }

    obj["ws-opts"] = wsOpts;
  }

  if (type === "grpc") {
    obj.network = "grpc";
    obj["grpc-opts"] = {
      "grpc-service-name": t.service_name || outbound.service_name || ""
    };
  }
}

/* -------------------- V2Ray -------------------- */

function toV2rayUri(p) {
  var o = p.outbound || {};
  var name = encodeURIComponent(renameProxy(p));

  var type = String(o.type || p.type || p.proxy_type || "").toLowerCase();
  var server = o.server || p.server;
  var port = o.server_port || o.port || p.port;

  if (!type || !server || !port) {
    return null;
  }

  if (type === "vless") {
    var uuid = o.uuid;
    var security = getTlsEnabled(o) ? "tls" : "none";
    var sni = getTlsServerName(o);

    return "vless://" +
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
      name;
  }

  if (type === "trojan") {
    var password = encodeURIComponent(o.password || "");
    var sni2 = getTlsServerName(o);

    return "trojan://" +
      password +
      "@" +
      server +
      ":" +
      port +
      "?security=tls&sni=" +
      encodeURIComponent(sni2) +
      "#" +
      name;
  }

  if (type === "shadowsocks" || type === "ss") {
    var method = String(o.method || "");
    var pass = String(o.password || "");
    var userInfo = btoa(method + ":" + pass);

    return "ss://" + userInfo + "@" + server + ":" + port + "#" + name;
  }

  return null;
}

/* -------------------- YAML 工具 -------------------- */

function yamlInline(obj) {
  var parts = [];
  var k;

  for (k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      continue;
    }

    var v = obj[k];
    if (v === undefined || v === null || v === "") {
      continue;
    }

    if (typeof v === "boolean" || typeof v === "number") {
      parts.push(k + ": " + String(v));
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
  var k;

  for (k in obj) {
    if (!Object.prototype.hasOwnProperty.call(obj, k)) {
      continue;
    }

    var v = obj[k];
    if (v === undefined || v === null || v === "") {
      continue;
    }

    if (typeof v === "boolean" || typeof v === "number") {
      parts.push(k + ": " + String(v));
    } else if (typeof v === "object") {
      parts.push(k + ": " + yamlObject(v));
    } else {
      parts.push(k + ": " + quote(String(v)));
    }
  }

  return "{ " + parts.join(", ") + " }";
}

function quote(s) {
  return JSON.stringify(String(s));
}

/* -------------------- 响应 -------------------- */

function base64Utf8(str) {
  var bytes = new TextEncoder().encode(str);
  var binary = "";

  for (var i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }

  return btoa(binary);
}

function textResponse(body, status) {
  return new Response(String(body), {
    status: status || 200,
    headers: {
      "content-type": "text/plain; charset=utf-8"
    }
  });
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
