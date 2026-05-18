export async function onRequest(context) {
  var request = context.request;
  var env = context.env;
  var url = new URL(request.url);

  var target = (url.searchParams.get("target") || "clash").toLowerCase();
  var count = Number(url.searchParams.get("count") || "200");

  var statusFilter = (url.searchParams.get("status") || "valid").toLowerCase();
  var qualityFilter = (url.searchParams.get("quality") || "chatgpt").toLowerCase();

  var countryFilter = url.searchParams.get("country");
  var typeFilter = url.searchParams.get("type");
  var debug = url.searchParams.get("debug") === "1";

  var riskMax = null;
  if (url.searchParams.get("risk_max")) {
    riskMax = Number(url.searchParams.get("risk_max"));
  }

  if (!env.ZENPROXY_BASE || !env.ZENPROXY_API_KEY) {
    return textResponse("Missing ZENPROXY_BASE or ZENPROXY_API_KEY", 500);
  }

  try {
    var allProxies = await fetchAllProxies(env);

    var beforeCount = allProxies.length;

    var filtered = allProxies.filter(function (p) {
      var status = String(p.status || "").toLowerCase();
      var q = p.quality || {};

      var chatgptOk =
        q.chatgpt === true ||
        q.chatgpt_accessible === true ||
        q.openai === true;

      var googleOk =
        q.google === true ||
        q.google_accessible === true;

      var country = q.country || p.country || "";
      var proxyType = String(p.type || p.proxy_type || "").toLowerCase();
      var risk = getRiskScore(q);

      if (statusFilter !== "any" && statusFilter !== "") {
        if (status !== statusFilter) {
          return false;
        }
      }

      if (qualityFilter === "chatgpt" && !chatgptOk) {
        return false;
      }

      if (qualityFilter === "google" && !googleOk) {
        return false;
      }

      if (qualityFilter === "any" || qualityFilter === "") {
        // no quality filter
      }

      if (countryFilter) {
        if (String(country).toUpperCase() !== countryFilter.toUpperCase()) {
          return false;
        }
      }

      if (typeFilter) {
        if (proxyType !== typeFilter.toLowerCase()) {
          return false;
        }
      }

      if (riskMax !== null && risk !== null && risk > riskMax) {
        return false;
      }

      return true;
    });

    var afterFilterCount = filtered.length;
    filtered = filtered.slice(0, count);

    if (debug) {
      return jsonResponse({
        ok: true,
        step: "filter",
        before_count: beforeCount,
        after_filter_count: afterFilterCount,
        after_slice_count: filtered.length,
        request: {
          target: target,
          count: count,
          status: statusFilter,
          quality: qualityFilter,
          country: countryFilter,
          type: typeFilter,
          risk_max: riskMax
        },
        first_5_filtered: filtered.slice(0, 5).map(function (p) {
          var q = p.quality || {};
          return {
            id: p.id || p.proxy_id || null,
            name: p.name || null,
            type: p.type || p.proxy_type || null,
            status: p.status || null,
            country: q.country || null,
            chatgpt: q.chatgpt === true || q.chatgpt_accessible === true || false,
            google: q.google === true || q.google_accessible === true || false,
            risk_score: q.risk_score !== undefined ? q.risk_score : (q.risk !== undefined ? q.risk : null),
            ip_type: q.ip_type || q.ipType || q.type || (q.is_residential ? "住宅IP" : null)
          };
        })
      });
    }

    if (!filtered.length) {
      return textResponse("No proxies matched: status=" + statusFilter + " and quality=" + qualityFilter, 404);
    }

    var detailed = await fetchDetailedProxies(env, filtered);

    if (!detailed.length) {
      return textResponse("No detailed proxies fetched from /api/client/fetch", 404);
    }

    if (target === "v2ray" || target === "base64") {
      var uriLines = detailed.map(toV2rayUri).filter(function (x) {
        return !!x;
      });

      if (!uriLines.length) {
        return textResponse("No V2Ray-compatible nodes after conversion", 404);
      }

      return new Response(base64Utf8(uriLines.join("\n")), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "profile-update-interval": "6"
        }
      });
    }

    var yaml = toClashYaml(detailed);

    if (!yaml) {
      return textResponse("No Clash-compatible nodes after conversion", 404);
    }

    return new Response(yaml, {
      headers: {
        "content-type": "text/yaml; charset=utf-8",
        "profile-update-interval": "6"
      }
    });
  } catch (err) {
    return textResponse("Error: " + String(err && err.message ? err.message : err), 500);
  }
}

async function fetchAllProxies(env) {
  var apiBase = String(env.ZENPROXY_BASE).replace(/\/$/, "");
  var url = new URL(apiBase + "/api/proxies");

  url.searchParams.set("api_key", env.ZENPROXY_API_KEY);

  var res = await fetch(url.toString(), {
    headers: {
      "Authorization": "Bearer " + env.ZENPROXY_API_KEY
    }
  });

  if (!res.ok) {
    throw new Error("/api/proxies failed: HTTP " + res.status);
  }

  var data = await res.json();
  var list = extractProxyList(data);

  if (!Array.isArray(list)) {
    throw new Error("Cannot parse proxy list from /api/proxies");
  }

  return list;
}

async function fetchDetailedProxies(env, filtered) {
  var result = [];
  var concurrency = Number(env.FETCH_CONCURRENCY || "10");
  var apiBase = String(env.ZENPROXY_BASE).replace(/\/$/, "");

  if (!concurrency || concurrency < 1) {
    concurrency = 10;
  }

  for (var i = 0; i < filtered.length; i += concurrency) {
    var batch = filtered.slice(i, i + concurrency);

    var items = await Promise.all(
      batch.map(async function (meta) {
        var id = meta.id || meta.proxy_id;

        if (!id) {
          return null;
        }

        var url = new URL(apiBase + "/api/client/fetch");
        url.searchParams.set("api_key", env.ZENPROXY_API_KEY);
        url.searchParams.set("proxy_id", id);

        var res = await fetch(url.toString(), {
          headers: {
            "Authorization": "Bearer " + env.ZENPROXY_API_KEY
          }
        });

        if (!res.ok) {
          return null;
        }

        var data = await res.json();

        if (!data || !Array.isArray(data.proxies) || !data.proxies.length) {
          return null;
        }

        var p = data.proxies[0];

        p.status = meta.status || p.status;
        p.original_name = meta.name || p.name || id;
        p.quality = mergeObjects(p.quality || {}, meta.quality || {});

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

  if (Array.isArray(data.data)) {
    return data.data;
  }

  if (data.data && Array.isArray(data.data.proxies)) {
    return data.data.proxies;
  }

  if (data.data && Array.isArray(data.data.items)) {
    return data.data.items;
  }

  if (data.data && Array.isArray(data.data.results)) {
    return data.data.results;
  }

  if (data.result && Array.isArray(data.result.proxies)) {
    return data.result.proxies;
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

function renameProxy(p) {
  var q = p.quality || {};

  var original = cleanName(p.original_name || p.name || p.id || "Proxy");
  var country = cleanName(q.country || p.country || "未知国家");

  var ipType =
    q.ip_type ||
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
  return !!(outbound && outbound.tls && outbound.tls.enabled);
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

function toV2rayUri(p) {
  var o = p.outbound || {};
  var name = encodeURIComponent(renameProxy(p));

  var type = String(o.type || p.type || p.proxy_type || "").toLowerCase();
  var server = o.server || p.server;
  var port = o.server_port || o.port || p.port;

  if (!type || !server || !port) {
    return null;
  }

  if (type === "vmess") {
    var vmessObj = {
      "v": "2",
      "ps": renameProxy(p),
      "add": server,
      "port": String(port),
      "id": o.uuid || "",
      "aid": String(o.alter_id || o.alterId || 0),
      "scy": o.security || "auto",
      "net": getTransportType(o),
      "type": "none",
      "host": "",
      "path": "",
      "tls": getTlsEnabled(o) ? "tls" : "",
      "sni": getTlsServerName(o)
    };

    if (o.transport && o.transport.type) {
      if (o.transport.type === "websocket" || o.transport.type === "ws") {
        vmessObj.net = "ws";
        vmessObj.path = o.transport.path || "/";
        if (o.transport.host) {
          vmessObj.host = o.transport.host;
        }
      }
      if (o.transport.type === "grpc") {
        vmessObj.net = "grpc";
        vmessObj.path = o.transport.service_name || "";
      }
    }

    var vmessJson = JSON.stringify(vmessObj);
    return "vmess://" + base64Utf8(vmessJson);
  }

  if (type === "vless") {
    var uuid = o.uuid || "";
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

  // 其他协议不输出到 V2Ray 订阅
  return null;
}

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

function jsonResponse(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8"
    }
  });
}
``
