(function(dumber) {

  dumber.NS = "http://dumber.igel.co.jp";
  dumber.NS_P = "http://dumber.igel.co.jp/p";

  // Create a Dumber context for the given target (document by default.) Nodes
  // created in this context will be extended with the Dumber prototypes.
  dumber.create_context = function(target)
  {
    if (target === undefined) target = document;
    var context = (target.ownerDocument || target).implementation
      .createDocument(dumber.NS, "context", null);

    context.createElement = function(name)
    {
      return wrap_element(Object.getPrototypeOf(this).createElementNS
        .call(this, dumber.NS, name));
    };

    context.createElementNS = function(ns, qname)
    {
      return wrap_element(Object.getPrototypeOf(this).createElementNS
        .call(this, ns, qname));
    };

    var loaded = { "": root };  // loaded documents
    var components = {};        // ids by component

    // Request for a component to be loaded. If the component was already
    // loaded, return the component node, otherwise return the boolean value
    // true to acknowledge the request. In that situation, a "@loaded" event
    // will be sent when loading has finished.
    context._load_component = function(url)
    {
      var split = url.split("#");
      var locator = split[0];
      var id = split[1];
      if (typeof loaded[locator] === "object") {
        return id ? components[url] : loaded[locator];
      } else {
        if (!loaded[locator]) {
          loaded[locator] = true;
          flexo.ez_xhr(locator, { responseType: "document" }, function(req) {
              if (!req.response) {
                flexo.notify(context, "@error", { url: url });
              } else {
                loaded[locator] = import_node(root, req.response.documentElement);
                flexo.notify(context, "@loaded");
              }
            });
        }
        return true;
      }
    };

    var root = wrap_element(context.documentElement);
    root.target = target;
    return root;
  };

  // Prototype for a component instance. Prototypes may be extended through the
  // <script> element.
  var component_instance =
  {
    // Initialize the instance from a <use> element given a <component>
    // description node.
    init: function(use, component, target)
    {
      this.use = use;
      this.component = component;
      this.views = {};     // rendered views by id
      this.uses = {};      // rendered uses by id
      this.rendered = [];  // root DOM nodes and use instances
      this.watchers = [];  // instances that have watches on this instance
      this.properties = {};
      Object.keys(component._properties).forEach(function(k) {
          if (!use._properties.hasOwnProperty(k)) {
            this.properties[k] = component._properties[k];
          }
        }, this);
      Object.keys(use._properties).forEach(function(k) {
          this.properties[k] = use._properties[k];
        }, this);
      Object.defineProperty(this, "target", { enumerable: true,
        get: function() { return target; },
        set: function(t) { target = t; this.render(); } });
      component._instances.push(this);
      return this;
    },

    // Unrender, then render the view when the target is an Element.
    render: function()
    {
      this.unrender();
      if (this.target instanceof Element) {
        if (this.component._view) {
          this.render_children(this.component._view, this.target);
        }
        this.update_title();
        this.component._watches.forEach(function(watch) {
            var instance = Object.create(watch_instance).init(watch, this);
            instance.render();
            this.rendered.push(instance);
          }, this);
      }
    },

    rendered_use: function(use)
    {
      this.rendered.push(use._instance);
      if (use._id) this.uses[use._id] = use._instance;
    },

    render_use: function(use, dest)
    {
      if (use._pending) return;
      var instance = use._render(dest);
      if (instance === true) {
        use._pending = true;
        flexo.log("Wait for {0} to load...".fmt(use._href));
        flexo.listen(use, "@loaded", (function() {
            flexo.log("... loaded", use);
            delete use._pending;
            this.rendered_use(use);
          }).bind(this));
      } else if (instance) {
        this.rendered_use(use);
      }
    },

    render_children: function(node, dest)
    {
      for (var ch = node.firstChild; ch; ch = ch.nextSibling) {
        if (ch.nodeType === 1) {
          if (ch.namespaceURI === dumber.NS) {
            if (ch.localName === "use") {
              this.render_use(ch, dest);
            } else if (ch.localName === "target") {
              if (ch._once) {
                if (!ch._rendered) {
                  this.render_children(ch, ch._find_target(dest));
                  ch._rendered = true;
                }
              } else {
                this.render_children(ch, ch._find_target(dest));
              }
            } else if (ch.localName === "content") {
              this.render_children(this.use.childNodes.length > 0 ?
                this.use : ch, dest);
            }
          } else {
            this.render_foreign(ch, dest);
          }
        } else if (ch.nodeType === 3 || ch.nodeType === 4) {
          var d = dest.ownerDocument.createTextNode(ch.textContent);
          dest.appendChild(d);
          if (dest === this.target) this.rendered.push(d);
        }
      }
    },

    render_foreign: function(node, dest)
    {
      var d = dest.ownerDocument.createElementNS(node.namespaceURI,
          node.localName);
      [].forEach.call(node.attributes, function(attr) {
          if ((attr.namespaceURI === flexo.XML_NS || !attr.namespaceURI) &&
            attr.localName === "id") {
            this.views[attr.value.trim()] = d;
          } else if (attr.namespaceURI) {
            d.setAttributeNS(attr.namespaceURI, attr.localName, attr.value);
          } else {
            d.setAttribute(attr.localName, attr.value);
          }
        }, this);
      dest.appendChild(d);
      if (dest === this.target) {
        [].forEach.call(this.use.attributes, function(attr) {
            if (!this.use._attributes.hasOwnProperty(attr.localName)) {
              d.setAttribute(attr.name, attr.value);
            }
          }, this);
        this.rendered.push(d);
      }
      this.render_children(node, d);
    },

    unrender: function()
    {
      this.rendered.forEach(function(r) {
        if (r instanceof Node) {
          r.parentNode.removeChild(r);
        } else {
          flexo.remove_from_array(r.component._instances, r);
          r.unrender();
        }
      }, this);
      this.rendered = [];
    },

    update_title: function()
    {
      if (this.target instanceof Node && this.component.localName === "app" &&
          this.use.parentNode === this.use.ownerDocument.documentElement &&
          this.component._title) {
        this.target.ownerDocument.title = this.component._title.textContent;
      }
    },
  };

  var watch_instance =
  {
    init: function(watch, component_instance)
    {
      this.watch = watch;
      this.component_instance = component_instance;
      this.component = this.component_instance.component;
      this.ungets = [];
      return this;
    },

    render: function()
    {
      this.watch._gets.forEach(function(get) {
          if (get._event) {
            var component_instance = this.component_instance;
            var listener = function(e) {
              flexo.log(get);
              return (get._action || flexo.id).call(component_instance, e);
            };
            if (get._view) {
              // DOM event from a view
              var target = this.component_instance.views[get._view];
              target.addEventListener(get._event, listener, false);
              this.ungets.push(function() {
                  target.removeEventListener(get._event, listener, false);
                });
            } else if (get._use) {
              var target = this.component_instance.uses[get._use];
              if (!target) {
                flexo.log("No view for \"{0}\"".fmt(get._use));
              } else {
                flexo.listen(target, get._event, listener);
                this.ungets.push(function() {
                    flexo.unlisten(target, get._event, listener);
                  });
              }
            }
          }
        }, this);
    },

    unrender: function()
    {
      this.ungets.forEach(function(unget) { unget(); });
    }
  };

  var prototypes =
  {
    "":
    {
      appendChild: function(ch) { return this.insertBefore(ch, null); },

      insertBefore: function(ch, ref)
      {
        Object.getPrototypeOf(this).insertBefore.call(this, ch, ref);
        flexo.log("insertBefore: refresh!");
        this._refresh();
        return ch;
      },

      removeChild: function(ch)
      {
        var parent = this.parentNode;
        Node.protoype.removeChild.call(this, ch);
        flexo.log("removeChild: refresh!");
        this._refresh(parent);
        return ch;
      },

      setAttribute: function(name, value)
      {
        Object.getPrototypeOf(this).setAttribute.call(this, name, value);
        flexo.log("setAttribute: refresh!");
        this._refresh();
      },

      setAttributeNS: function(ns, name, value)
      {
        Object.getPrototypeOf(this).setAttributeNS.call(this, ns, name, value);
        flexo.log("setAttributeNS: refresh!");
        this._refresh();
      },

      _textContent: function(t)
      {
        this.textContent = t;
        flexo.log("textContent: refresh!");
        this._refresh();
      },

      // TODO allow class/id in any order
      $: function(name)
      {
        var argc = 1;
        var attrs = {};
        if (typeof arguments[1] === "object" &&
            !(arguments[1] instanceof Node)) {
          argc = 2;
          attrs = arguments[1];
        }
        var m = name.match(
            // 1: prefix 2: name  3: classes    4: id        5: more classes
            /^(?:(\w+):)?([\w\-]+)(?:\.([^#]+))?(?:#([^.]+))?(?:\.(.+))?$/
          );
        if (m) {
          var ns = m[1] && flexo[m[1].toUpperCase() + "_NS"];
          var elem = ns ? this.ownerDocument.createElementNS(ns, m[2]) :
            this.ownerDocument.createElement(m[2]);
          var classes = m[3] ? m[3].split(".") : [];
          if (m[5]) [].push.apply(classes, m[5].split("."));
          if (m[4]) attrs.id = m[4];
          if (classes.length > 0) {
            attrs["class"] =
              (attrs.hasOwnProperty("class") ? attrs["class"] + " " : "") +
              classes.join(" ");
          }
          for (a in attrs) {
            if (attrs.hasOwnProperty(a) &&
                attrs[a] !== undefined && attrs[a] !== null) {
              var split = a.split(":");
              ns = split[1] && (dumber["NS_" + split[0].toUpperCase()] ||
                  flexo[split[0].toUpperCase() + "_NS"]);
              if (ns) {
                elem.setAttributeNS(ns, split[1], attrs[a]);
              } else {
                elem.setAttribute(a, attrs[a]);
              }
            }
          }
          [].slice.call(arguments, argc).forEach(function(ch) {
              if (typeof ch === "string") {
                elem.insertBefore(this.ownerDocument.createTextNode(ch));
              } else if (ch instanceof Node) {
                elem.insertBefore(ch);
              }
            }, this);
          return elem;
        }
      },

      _refresh: function(parent)
      {
        if (!parent) parent = this.parentNode;
        var component = component_of(parent);
        if (component) {
          component._instances.forEach(function(i) { i.render(); });
        }
      },

      _serialize: function()
      {
        return (new XMLSerializer).serializeToString(this);
      }
    },

    component:
    {
      _init: function()
      {
        this._components = {};  // child components
        this._watches = [];     // child watches
        this._scripts = [];     // child scripts
        this._instances = [];   // instances of this component
        this._properties = {};  // properties map
        this._url = "";
        flexo.getter_setter(this, "_is_component", function() { return true; });
      },

      insertBefore: function(ch, ref)
      {
        Object.getPrototypeOf(this).insertBefore.call(this, ch, ref);
        if (ch.namespaceURI === dumber.NS) {
          if (ch.localName === "app" || ch.localName === "component") {
            this._add_component(ch);
          } else if (ch.localName === "desc") {
            if (this._desc) {
              Object.getPrototypeOf(this).removeChild.call(this, this._desc);
            }
            this._desc = ch;
          } else if (ch.localName === "script") {
            this._scripts.push(ch);
          } else if (ch.localName === "title") {
            if (this._title) {
              Object.getPrototypeOf(this).removeChild.call(this, this._title);
            }
            this._title = ch;
            this._instances.forEach(function(i) { i.update_title(); });
          } else if (ch.localName === "view") {
            if (this._view) {
              Object.getPrototypeOf(this).removeChild.call(this, this._view);
            }
            this._view = ch;
            flexo.log("component._view added, refresh!");
            this._refresh();
          } else if (ch.localName === "use") {
            this._insert_use(ch);
          } else if (ch.localName === "watch") {
            this._watches.push(ch);
            flexo.log("component._watches: watch added, refresh!");
            this._refresh();
          }
        }
        return ch;
      },

      _insert_use: function(use)
      {
        var instance = use._render(this.target);
        if (instance === true) {
          flexo.log("insertBefore: wait for {0} to load...".fmt(use._href));
          flexo.listen(use, "@loaded", (function(e) {
              flexo.log("... loaded", e.instance);
              this._instances.push(e.instance);
            }).bind(this));
        } else if (instance) {
          this._instances.push(instance);
        }
      },

      removeChild: function(ch)
      {
        Object.getPrototypeOf(this).removeChild.call(this, ch);
        if (ch._id && this._components[ch._id]) {
          delete this._components[ch._id];
        } else if (ch === this._desc) {
          delete this._desc;
        } else if (ch === this._title) {
          delete this._title;
        } else if (ch === this._view) {
          delete this._view;
          flexo.log("component._view deleted, refresh!");
          this._refresh();
        } else if (ch._unrender) {
          flexo.remove_from_array(this._instances, ch._instance);
          ch._unrender();
        }
        // TODO watch?
        return ch;
      },

      setAttribute: function(name, value)
      {
        if (name === "id") {
          this._id = value.trim();
          if (this.parentNode && this.parentNode._add_component) {
            this.parentNode._add_component(this);
          }
        }
        Object.getPrototypeOf(this).setAttribute.call(this, name, value);
      },

      // TODO support xml:id?
      setAttributeNS: function(ns, name, value)
      {
        if (ns === dumber.NS_P) this._properties[name] = value;
        Object.getPrototypeOf(this).setAttributeNS.call(this, ns, name, value);
      },

      _add_component: function(component)
      {
        if (component._id) {
          // TODO check for duplicate id
          this._components[component._id] = component;
        }
      },

      _render_in: function(target)
      {
        return render_component(this, target,
            this.ownerDocument.createElement("use"));
      },
    },

    get:
    {
      insertBefore: function(ch, ref)
      {
        Object.getPrototypeOf(this).insertBefore.call(this, ch, ref);
        if (ch.nodeType === 3 || ch.nodeType === 4) this._update_action();
        return ch;
      },

      setAttribute: function(name, value)
      {
        Object.getPrototypeOf(this).setAttribute.call(this, name, value);
        if (name === "event" || name === "use" || name === "view") {
          this["_" + name] = value.trim();
        }
      },

      _textContent: function(t)
      {
        this.textContent = t;
        this._update_action();
      },

      _update_action: function()
      {
        if (/\S/.test(this.textContent)) {
          // TODO handle errors
          this._action = new Function("value", this.textContent);
        } else {
          delete this._action;
        }
      }
    },

    target:
    {
      setAttribute: function(name, value)
      {
        Object.getPrototypeOf(this).setAttribute.call(this, name, value);
        if (name === "q" || name === "ref") {
          this["_" + name] = value.trim();
          flexo.log("target: set attribute {0}, refresh!".fmt(name));
          this._refresh();
        } else if (name === "once") {
          this._once = value.trim().toLowerCase() === "true";
          flexo.log("target: set once to {0}, refresh!".fmt(this._once));
          this._refresh();
        }
      },

      _find_target: function(dest)
      {
        if (this._q) {
          return dest.ownerDocument.querySelector(this._q);
        } else if (this._ref) {
          return dest.ownerDocument.getElementById(this._ref);
        } else {
          return dest;
        }
      }
    },

    use:
    {
      _init: function()
      {
        this._properties = {};
      },

      // Attributes interpreted by use
      _attributes: { href: true, id: true, q: true, ref: true },

      setAttribute: function(name, value)
      {
        Object.getPrototypeOf(this).setAttribute.call(this, name, value);
        if (this._attributes.hasOwnProperty(name)) {
          this["_" + name] = value.trim();
        }
        flexo.log("use: set {0}, refresh!".fmt(name));
        this._refresh();
      },

      setAttributeNS: function(ns, name, value)
      {
        if (ns === dumber.NS_P) this._properties[name] = value;
        Object.getPrototypeOf(this).setAttributeNS.call(this, ns, name, value);
      },

      _find_component: function()
      {
        var component = undefined;
        if (this._ref) {
          var parent_component = component_of(this);
          while (!component && parent_component) {
            component = parent_component._components[this._ref];
            parent_component = component_of(parent_component.parentNode);
          }
          return component;
        } else if (this._q) {
          return this.parentNode && this.parentNode.querySelector(this._q);
        } else if (this._href) {
          return this.ownerDocument._load_component(this._href);
        }
      },

      _render: function(target)
      {
        var component = this._find_component();
        if (component === true) {
          flexo.listen(this.ownerDocument, "@loaded", (function() {
              flexo.notify(this, "@loaded", { instance: this._render(target) });
            }).bind(this));
          return true;
        } else if (component) {
          var instance = render_component(component, target, this);
          if (instance) {
            this._instance = instance;
            return instance;
          } else {
            flexo.log("No component found for", this);
          }
        }
      },

      _unrender: function()
      {
        if (this._instance) {
          this._instance.unrender();
          delete this._instance;
        }
      },
    },

    view:
    {
      insertBefore: function(ch, ref)
      {
        Object.getPrototypeOf(this).insertBefore.call(this, ch, ref);
        if (ch.namespaceURI === dumber.NS) {
          if (ch.localName === "use") {
            flexo.log("view: added use, refresh!");
            this._refresh();
          }
        } else {
          flexo.log("view: added element child, refresh!");
          this._refresh();
        }
        return ch;
      },

      removeChild: function(ch)
      {
        Object.getPrototypeOf(this).removeChild.call(this, ch);
        flexo.log("view: removed child, refresh!");
        this._refresh();
        return ch;
      },
    },

    watch:
    {
      _init: function()
      {
        this._gets = [];
        this._sets = [];
        this._watches = [];
      },

      insertBefore: function(ch, ref)
      {
        Object.getPrototypeOf(this).insertBefore.call(this, ch, ref);
        if (ch.namespaceURI === dumber.NS) {
          if (ch.localName === "get") {
            this._gets.push(ch);
          } else if (ch.localName === "set") {
            this._sets.push(ch);
          } else if (ch.localName === "watch") {
            this._watches.push(ch);
          }
        }
      },
    }
  };

  prototypes.app = prototypes.component;
  prototypes.context = prototypes.component;

  // The component of a node is itself if it is a component node (or app or
  // context), or the component of its parent
  function component_of(node)
  {
    return node ? node._is_component ? node : component_of(node.parentNode) :
      null;
  }

  function import_node(parent, node, uri)
  {
    if (node.nodeType === 1) {
      var n = parent.ownerDocument
        .createElementNS(node.namespaceURI, node.localName);
      if (n._is_component) n._uri = uri;
      parent.appendChild(n);
      for (var i = 0, m = node.attributes.length; i < m; ++i) {
        var attr = node.attributes[i];
        if (attr.namespaceURI) {
          if (attr.namespaceURI === flexo.XMLNS_NS &&
              attr.localName !== "xmlns") {
            n.setAttribute("xmlns:{0}".fmt(attr.localName), attr.nodeValue);
          } else {
            n.setAttributeNS(attr.namespaceURI, attr.localName, attr.nodeValue);
          }
        } else {
          n.setAttribute(attr.localName, attr.nodeValue);
        }
      }
      for (var ch = node.firstChild; ch; ch = ch.nextSibling) {
        import_node(n, ch, uri);
      }
      return n;
    } else if (node.nodeType === 3 || node.nodeType === 4) {
      var n = parent.ownerDocument.importNode(node, false);
      parent.appendChild(n);
    }
  }

  function render_component(component, target, use)
  {
    if (!component) return;
    var instance = Object.create(component_instance).init(use, component);
    component._scripts.forEach(function(script) {
        (new Function("prototype", script.textContent))(instance);
      });
    if (instance.instantiated) instance.instantiated();
    instance.target = target;
    return instance;
  }

  // Extend an element with Dumber methods and call the _init() method on the
  // node if it exists.
  function wrap_element(e)
  {
    var proto = prototypes[e.localName] || {};
    for (var p in proto) e[p] = proto[p];
    for (var p in prototypes[""]) {
      if (!e.hasOwnProperty(p)) e[p] = prototypes[""][p];
    }
    if (e._init) e._init();
    return e;
  }

})(typeof exports === "object" ? exports : this.dumber = {});