// Morbo HTTP server for use with Bender
/*jslint indent: 2 */

(function () {
  "use strict";

  var args,
    fs = require("fs"),
    http = require("http"),
    path = require("path"),
    url = require("url"),
    util = require("util"),
    flexo = require("flexo"),
    APPS = [],
    PORT = 8910,
    IP = "",
    HELP = false;


  // These can (and sometime should) be overridden

  // Default document root
  exports.DOCUMENTS = path.join(process.cwd(), "docs");

  // Default server name
  exports.SERVER_NAME = "MORBO!";

  // Patterns for dispatch: applications will add their own patterns
  // A pattern is of the form: [/path regex/, { GET: ..., PUT: ... }]
  exports.PATTERNS = [];

  // Known MIME types associated with file extensions
  exports.TYPES = {
    css: "text/css",
    es: "application/ecmascript",
    html: "text/html",
    jpg: "image/jpeg",
    js: "application/javascript",
    json: "application/json",
    m4v: "video/mp4",
    manifest: "text/cache-manifest",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    png: "image/png",
    pdf: "application/pdf",
    svg: "image/svg+xml",
    ttf: "application/octet-stream",
    wav: "audio/x-wav",
    xml: "application/xml",
    xhtml: "application/xhtml+xml",
    xslt: "application/xslt+xml",
  };

  // Known error codes
  exports.STATUS_CODES = {
    // 1xx Informational
    100: "Continue",
    101: "Switching Protocols",
    // 2xx Successful
    200: "OK",
    201: "Created",
    202: "Accepted",
    203: "Non-Authoritative Information",
    204: "No Content",
    205: "Reset Content",
    206: "Partial Content",
    // 3xx Redirection
    300: "Multiple Choices",
    301: "Moved Permanently",
    302: "Found",
    303: "See Other",
    304: "See Other",
    305: "Use Proxy",
    307: "Temporary Redirect",
    // 4xx Client error
    400: "Bad Request",
    401: "Unauthorized",
    402: "Payment Required",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    406: "Not Acceptable",
    407: "Proxy Authentication Required",
    408: "Request Timeout",
    409: "Conflict",
    410: "Gone",
    411: "Length Required",
    412: "Precondition Failed",
    413: "Request Entity Too Large",
    414: "Request-URI Too Long",
    415: "Unsupported Media Type",
    416: "Request Range Not Satisfiable",
    417: "Expectation Failed",
    // 5xx Server error
    500: "Internal Server Error",
    501: "Not Implemented",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
    505: "HTTP Version Not Supported"
  };


  // Check that path p is rooted at root
  function check_path(p, root) {
    root = path.normalize(root);
    var abs = path.normalize(p);
    return abs.substr(0, root.length) === root;
  }

  // Write the correct headers (plus the ones already given, if any)
  // TODO don't replace headers that have already been set
  function write_head(transaction, code, type, data, params) {
    if (typeof params !== "object") {
      params = {};
    }
    if (!params.hasOwnProperty("Accept-Ranges")) {
      params["Accept-Ranges"] = "bytes";
    }
    if (!params.hasOwnProperty("Content-Length")) {
      params["Content-Length"] = data ? Buffer.byteLength(data.toString()) : 0;
    }
    if (type && !params.hasOwnProperty("Content-Type")) {
      if (!(/\bcharset=/.test(type)) && /script|text|xml/.test(type)) {
        type += "; charset=utf-8";
      }
      params["Content-Type"] = type;
    }
    params.Date = (new Date()).toUTCString();
    params.Server = exports.SERVER_NAME;
    transaction.response.writeHead(code, params);
    transaction.log_info += " {0} {1}".fmt(code, params["Content-Length"]);
  }

  // Serve a file from its actual path after we checked that it is indeed a file.
  // Pass the stats result along to fill out the headers, and the URI if it was a
  // directory request to set the Content-Location header
  // TODO improve range request stuff (factor it out?)
  function serve_file(transaction, p, stats, uri) {
    var d, type, params, m, from, to, size, buffers, length, file, buffer, pos;
    if (transaction.request.headers.hasOwnProperty("if-modified-since")) {
      d = new Date(transaction.request.headers["if-modified-since"]);
      if (stats.mtime <= d) {
        transaction.serve_data(304);
        return;
      }
    }
    // TODO If-None-Match
    type = exports.TYPES[path.extname(p).substr(1).toLowerCase()] || "";
    params = { "Last-Modified": stats.mtime.toUTCString(),
      ETag: "\"{0}-{1}-{2}\"".fmt(stats.ino.toString(16),
        stats.size.toString(16), stats.mtime.valueOf().toString(16)) };
    if (uri) {
      params["Content-Location"] = uri;
    }
    if (transaction.request.headers.hasOwnProperty("range")) {
      m = (transaction.request.headers.range.match(/^bytes=(\d+)\-(\d*)/));
      if (m) {
        from = parseInt(m[1], 10);
        to = m[2] ? parseInt(m[2], 10) : stats.size - 1;
        size = to - from + 1;
        if (size < stats.size) {
          buffers = [];
          length = 0;
          file = fs.createReadStream(p);
          file.on("data", function (chunk) {
            buffers.push(chunk);
            length += chunk.length;
          });
          file.on("end", function () {
            buffer = new Buffer(length);
            pos = 0;
            buffers.forEach(function (b) {
              b.copy(buffer, pos);
              pos += b.length;
            });
            params["Content-Length"] = size;
            params["Content-Range"] = "bytes {0}-{1}/{2}"
              .fmt(from, to, stats.size);
            write_head(transaction, 206, type, null, params);
            if (transaction.request.method.toUpperCase() === "HEAD") {
              transaction.response.end();
            } else {
              transaction.response.write(buffer.slice(from, from + size));
            }
          });
          return;
        }
      } else {
        transaction.serve_error(416, "Unsupported range request \"{0}\""
            .fmt(transaction.request.headers.range));
        return;
      }
    }
    params["Content-Length"] = stats.size;
    write_head(transaction, 200, type, null, params);
    if (transaction.request.method.toUpperCase() === "HEAD") {
      transaction.response.end();
    } else {
      util.pump(fs.createReadStream(p), transaction.response);
    }
    util.log(transaction.log_info);
  }

  // Simply serve the requested file if found, otherwise return a 404/500 error
  // or a 403 error if it's not a file. The index parameter is set to true when
  // we're looking for the index page of a directory. No directory listing at the
  // moment.
  // TODO optionally allow directory listing
  // TODO alternatives for index page
  function serve_file_or_index(transaction, uri, index) {
    var p = path.join(exports.DOCUMENTS, uri);
    if (!check_path(p, exports.DOCUMENTS)) {
      transaction.serve_error(403, "Path \"{0}\" is out of bounds".fmt(p));
    }
    path.exists(p, function (exists) {
      if (!exists) {
        if (index) {
          return transaction.serve_error(403,
            "serve_file_or_index: Index page \"{0}\" not found".fmt(p));
        }
        return transaction.serve_error(404,
          "serve_file_or_index: File \"{0}\" not found".fmt(p));
      }
      fs.stat(p, function (error, stats) {
        if (error) {
          return transaction.serve_error(500,
            "serve_file_or_index: " + error);
        }
        if (stats.isFile()) {
          serve_file(transaction, p, stats, index ? uri : undefined);
        } else if (stats.isDirectory() && /\/$/.test(p)) {
          serve_file_or_index(transaction, path.join(uri, "index.html"),
              true);
        } else {
          transaction.serve_error(403,
            "serve_file_or_directory: no access to \"{0}\"".fmt(p));
        }
      });
    });
  }

  // A transaction object so that we don't have to pass request/response
  // everywhere
  exports.TRANSACTION = {

    init: function (server, request, response) {
      this.server = server;
      this.request = request;
      this.response = response;
      this.url = url.parse(request.url, true);
      this.log_info = "{0} {1} {2}".fmt(request.connection.remoteAddress,
          request.method, request.url);
      return this;
    },

    // Get the cookies from the request
    get_cookies: function () {
      var cookies = {};
      if (this.request.headers.cookie) {
        this.request.headers.cookie.split(";").forEach(function (cookie) {
          var parts = cookie.split("=");
          cookies[parts[0].trim()] = (parts[1] || "").trim();
        });
      }
      return cookies;
    },

    // Get data from the request
    get_data: function (f) {
      var data = "";
      this.request.on("data", function (chunk) { data += chunk.toString(); });
      this.request.on("error", function () { f(); });
      this.request.on("end", function () { f(data); });
    },

    // Serve data by writing the correct headers (plus the ones already given, if
    // any) and the data
    serve_data: function (code, type, data, params) {
      write_head(this, code, type, data, params);
      if (this.request.method.toUpperCase() === "HEAD") {
        this.response.end();
      } else {
        this.response.end(data);
      }
      util.log(this.log_info);
      if (this.log_error) {
        util.log(this.log_error);
      }
    },

    // Return an error as text with a code and an optional debug message
    // TODO provide a function to customize error pages
    serve_error: function (code, log) {
      var msg = exports.STATUS_CODES[code] || "(unknown error code)";
      if (log) {
        this.log_error = "{0}: {1} ({2})".fmt(code, msg, log);
      }
      this.serve_data(code, "text/plain", "{0} {1}\n".fmt(code, msg));
    },

    // Serve file from a known pathname
    serve_file_from_path: function (p, rel) {
      if (rel) {
        p = path.resolve(exports.DOCUMENTS, p);
      }
      fs.stat(p, function (error, stats) {
        if (error) {
          this.serve_error(500, "serve_file_from_path: " + error);
        } else if (!stats.isFile()) {
          this.serve_error(500,
              "serve_file_from_path: Expected a file at " + p);
        } else {
          serve_file(this, p, stats);
        }
      }.bind(this));
    },

    // Serve a string as an HTML document
    serve_html: function (html) {
      this.serve_data(200, exports.TYPES.html, html);
    },

    // Return a js value encoded as JSON.
    // Set the raw flag to prevent the data to be reencoded.
    serve_json: function (result, raw) {
      var data = raw ? result : JSON.stringify(result);
      this.serve_data(200, exports.TYPES.json, data);
    },

    // Serve a string as plain text
    serve_text: function (text) {
      this.serve_data(200, exports.TYPES.text, text);
    },

    // Serve a string as an SVG document
    serve_svg: function (svg) {
      this.serve_data(200, exports.TYPES.svg, svg);
    }
  };


  // Run the server on the given port/ip, using the patterns list for dispatch
  // (default is simply to serve a file in the DOCUMENTS directory with the given
  // pathname)
  exports.run = function (ip, port) {
    http.createServer(function (request, response) {
      var i, m, n, methods, allowed, args,
        transaction = Object.create(exports.TRANSACTION).init(exports,
          request, response),
        pathname = decodeURIComponent(transaction.url.pathname),
        method = request.method.toUpperCase();
      if (method === "HEAD") {
        method = "GET";
      }
      for (i = 0, n = exports.PATTERNS.length; i < n; i += 1) {
        m = pathname.match(exports.PATTERNS[i][0]);
        if (m) {
          methods = exports.PATTERNS[i][1];
          if (!methods.hasOwnProperty(method)) {
            allowed = [];
            if (methods.hasOwnProperty("GET")) {
              allowed.push("HEAD");
            }
            [].push.apply(allowed, Object.keys(methods));
            transaction.response.setHeader("Allow", allowed.sort().join(", "));
            return transaction.serve_error(405,
              "Method {0} not allowed for {1}".fmt(method, pathname));
          }
          args = m.slice(1);
          args.unshift(transaction);
          return methods[method].apply(exports, args);
        }
      }
      if (method === "GET") {
        serve_file_or_index(transaction, pathname);
      } else {
        transaction.response.setHeader("Allow", "GET, HEAD");
        transaction.serve_error(405,
          "Method {0} not allowed for {1}".fmt(method, pathname));
      }
    }).listen(port, ip, function () {
      util.log("http://{0}:{1} ready".fmt(ip || "localhost", port));
    });
  };


  // HTML and SVG creation

  // Make a (text) HTML tag; the first argument is the tag name. Following
  // arguments are the contents (as text; must be properly escaped.) If the last
  // argument is a boolean, it is treated as a flag to *not* close the element
  // when true (i.e. for elements that are incomplete or HTML elements that do not
  // need to be closed)
  // TODO handle encoding (at least of attribute values)
  function html_tag(tag) {
    var attrs, a, v, keep_open,
      out = "<" + tag,
      contents = [].slice.call(arguments, 1);
    if (typeof contents[0] === "object") {
      attrs = contents.shift();
      for (a in attrs) {
        if (attrs.hasOwnProperty(a)) {
          v = attrs[a];
          // true and false act as special values: when true, just output the
          // attribute name (without any value); when false, skip the attribute
          // altogether
          if (v !== false) {
            out += (v === true ? " {0}" : " {0}=\"{1}\"").fmt(a, v);
          }
        }
      }
    }
    out += ">";
    keep_open = typeof contents[contents.length - 1] === "boolean" ?
        contents.pop() : false;
    out += contents.join("");
    if (!keep_open) {
      out += "</{0}>".fmt(tag);
    }
    return out;
  }

  // Shortcut for HTML and SVG elements: the element name prefixed by a $ sign
  // See http://dev.w3.org/html5/spec/Overview.html#elements-1 (HTML)
  // and http://www.w3.org/TR/SVG/eltindex.html (SVG, excluding names using -)
  ["a", "abbr", "address", "altGlyph", "altGlyphDef", "altGlyphItem", "animate",
    "animateColor", "animateMotion", "animateTransform", "area", "article",
    "aside", "audio", "b", "base", "bdi", "bdo", "blockquote", "body", "br",
    "button", "canvas", "caption", "circle", "cit", "clipPath", "code", "col",
    "colgroup", "command", "cursor", "datalist", "dd", "defs", "del", "desc",
    "details", "dfn", "div", "dl", "dt", "ellipse", "em", "embed", "feBlend",
    "feColorMatrix", "feComponentTransfer", "feComposite", "feConvolveMatrix",
    "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feFlood",
    "feFuncA", "feFuncB", "feFuncG", "feFuncR", "feGaussianBlur", "feImage",
    "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight",
    "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence", "fieldset",
    "figcaption", "figure", "filter", "font", "footer", "foreignObject", "form",
    "g", "glyph", "glyphRef", "h1", "h2", "h3", "h4", "h5", "h6", "head",
    "header", "hgroup", "hkern", "hr", "html", "i", "iframe", "image", "img",
    "input", "ins", "kbd", "keygen", "label", "legend", "li", "line",
    "linearGradient", "link", "map", "mark", "marker", "mask", "menu", "meta",
    "metadata", "meter", "mpath", "nav", "noscript", "object", "ol", "optgroup",
    "option", "output", "p", "param", "path", "pattern", "polygon", "polyline",
    "pre", "progress", "q", "radialGradient", "rect", "rp", "rt", "ruby", "s",
    "samp", "script", "section", "select", "set", "small", "source", "span",
    "stop", "strong", "style", "sub", "summary", "sup", "svg", "switch", "symbol",
    "table", "tbody", "td", "text", "textarea", "textPath", "tfoot", "th",
    "thead", "time", "title", "tr", "tref", "tspan", "track", "u", "ul", "use",
    "var", "video", "view", "vkern", "wbr"].forEach(function (tag) {
    this["$" + tag] = html_tag.bind(this, tag);
  }.bind(this));

  // Some more shortcuts
  (function () {

    this.$$script = function (src) {
      return html_tag("script", { src: src });
    };

    this.$$stylesheet = function (href) {
      return html_tag("link",
        { rel: "stylesheet", type: "text/css", href: href }, true);
    };

    // Params should include at least "title"; "lang" and "charset" have default
    // values. DOCTYPE can be overridden with the DOCTYPE parameter.
    this.html_header = function (params, head) {
      if (typeof params !== "object") {
        params = {};
      }
      if (head === undefined || head === null) {
        head = "";
      }
      if (!params.DOCTYPE) {
        params.DOCTYPE = "<!DOCTYPE html>";
      }
      if (!params.title) {
        params.title = "Untilted";
      }
      if (!params.charset) {
        params.charset = "UTF-8";
      }
      return params.DOCTYPE  + "\n" +
        $html({ lang: params.lang },
          $head(
            $title(params.title),
            $meta({ charset: params.charset }, true),
            head),
          $body(true), true);
    };

    this.html_footer = function () {
      return "</body></html>";
    };

    this.html_page = function (params, head, body) {
      return html_header(params, head) + body + html_footer();
    };

  }.call(this));

  // Parse arguments from the command line
  function parse_args(args) {
    var m;
    args.forEach(function (arg) {
      if (m = arg.match(/^port=(\d+)/)) {
        PORT = parseInt(m[1], 10);
      } else if (m = arg.match(/^ip=(\S*)/)) {
        IP = m[1];
      } else if (arg.match(/^h(elp)?$/i)) {
        HELP = true;
      } else if (m = arg.match(/^documents=(\S+)/)) {
        exports.DOCUMENTS = m[1];
      } else if (m = arg.match(/^app=(\S+)/)) {
        APPS.push(m[1]);
      }
    });
  }

  // Show help info and quit
  function show_help(node, name) {
    console.log("\nUsage: {0} {1} [options]\n\nOptions:".fmt(node, name));
    console.log("  app=<app.js>:         path to application file");
    console.log("  documents=<apps dir>: path to the documents directory");
    console.log("  help:                 show this help message");
    console.log("  ip=<ip address>:      IP address to listen to");
    console.log("  port=<port number>:   port number for the server");
    console.log("");
    process.exit(0);
  }

  if (require.main === module) {
    // Run the server
    args = process.argv.slice(2);
    parse_args(args);
    if (HELP) {
      show_help.apply(null, process.argv);
    }
    util.log("Documents root: " + exports.DOCUMENTS);
    flexo.async_foreach.trampoline(function (k, appname) {
      util.log("App: {0} ({1})".fmt(appname, require.resolve(appname)));
      var app = require(appname);
      [].unshift.apply(exports.PATTERNS, app.PATTERNS);
      if (app.init) {
        return app.init.get_thunk(exports, args, k);
      }
      return k.get_thunk();
    }, APPS, function () {
      exports.run(IP, PORT);
    });
  }

}.call(this));
