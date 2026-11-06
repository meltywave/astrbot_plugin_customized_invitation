const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(
  path.join(__dirname, "pages", "editor", "index.html"),
  "utf8",
);
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
assert.ok(script, "editor script must exist");

function createEditor(
  templateData = { templates: {} },
  fetchImpl = async () => ({ blob: async () => ({}) }),
) {
  const elements = new Map();
  let nextElement = 0;
  const textDraws = [];
  const lineDraws = [];
  const context2d = {
    clearRect() {},
    drawImage() {},
    fillRect() {},
    setLineDash() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {
      this.path = [];
    },
    arc() {},
    moveTo(x, y) {
      this.path.push([x, y]);
    },
    lineTo(x, y) {
      this.path.push([x, y]);
    },
    fill() {},
    stroke() {
      lineDraws.push(this.path);
    },
    measureText(text) {
      const size = Number(this.font.match(/[\d.]+(?=px)/)?.[0]);
      return {
        width: size * Array.from(text).length * 0.6,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
      };
    },
    fillText(text, x, y, maxWidth) {
      textDraws.push({ text, x, y, font: this.font, maxWidth });
    },
  };

  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      const classes = new Set();
      const attributes = new Map();
      elements.set(id, {
        id,
        value: id === "fontSizeInput" ? "48" : id === "previewTextInput" ? "Name preview" : id === "zoomInput" ? "100" : "",
        disabled: id === "undoBtn" || id === "redoBtn",
        style: {},
        offsetHeight: id === "selectionToolbar" ? 100 : 0,
        classList: {
          toggle(name, enabled) {
            if (enabled) classes.add(name);
            else classes.delete(name);
          },
          contains(name) {
            return classes.has(name);
          },
        },
        setAttribute(name, value) {
          attributes.set(name, value);
        },
        getAttribute(name) {
          return attributes.get(name);
        },
        children: [],
        focus() {},
        replaceChildren(...children) {
          this.children = children;
        },
        addEventListener(type, callback) {
          listeners.set(type, callback);
        },
        dispatch(type, event = {}) {
          return listeners.get(type)?.(event);
        },
        click() {
          return this.dispatch("click");
        },
        appendChild(child) {
          this.children.push(child);
        },
        querySelectorAll() {
          return [];
        },
      });
    }
    return elements.get(id);
  }

  const canvas = element("canvas");
  const canvasWrap = element("canvasWrap");
  Object.assign(canvas, {
    width: 960,
    height: 540,
    clientWidth: 960,
    clientHeight: 540,
    clientLeft: 0,
    clientTop: 0,
    getContext: () => context2d,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: canvas.clientWidth, bottom: canvas.clientHeight }),
  });
  Object.assign(canvasWrap, {
    bounds: { left: -60, top: -160, right: 1020, bottom: 700 },
    clientWidth: 1080,
    clientHeight: 680,
    scrollWidth: 1080,
    scrollLeft: 0,
    getBoundingClientRect() {
      return this.bounds;
    },
    setPointerCapture(id) {
      this.capturedPointer = id;
    },
    hasPointerCapture(id) {
      return this.capturedPointer === id;
    },
    releasePointerCapture() {
      this.capturedPointer = null;
    },
  });

  const document = {
    getElementById: element,
    querySelector: () => canvasWrap,
    createElement: () => element(`dynamic-${nextElement++}`),
  };
  const saved = [];
  const configRequests = [];
  const deleteRequests = [];
  const listRequests = [];
  const scheduledTimers = new Map();
  let nextTimer = 0;
  element("drawerOverlay").hidden = true;
  element("deleteConfirmOverlay").hidden = true;
  element("canvasEmptyState").hidden = true;
  const windowListeners = new Map();
  const window = {
    location: { search: "", hash: "" },
    innerWidth: 1400,
    innerHeight: 800,
    addEventListener(type, callback) {
      windowListeners.set(type, [...(windowListeners.get(type) || []), callback]);
    },
    dispatch(type, event) {
      for (const callback of windowListeners.get(type) || []) callback(event);
    },
    AstrBotPluginPage: {
      ready: async () => {},
      apiGet: async (endpoint) => {
        listRequests.push(endpoint);
        const response = { ...templateData };
        templateData.first_visit = false;
        return response;
      },
      apiPost: async (endpoint, payload) => {
        if ((endpoint === "editor/template-config" && payload.action === "delete") ||
            endpoint === "editor/delete-template") {
          deleteRequests.push(payload);
          delete templateData.templates[payload.template];
          if (templateData.current === payload.template) templateData.current = "";
          return { status: "ok", deleted: payload.template };
        }
        if (endpoint === "editor/template-config") {
          configRequests.push(payload);
          const id = payload.action === "bind" ? payload.template : payload.display_name;
          if (payload.action === "create") {
            templateData.templates[id] = {
              display_name: id,
              preview: payload.preview || "",
              background: payload.preview || "",
              background_color: "#ffffff",
              width: payload.preview ? 320 : 960,
              height: payload.preview ? 180 : 540,
              layer: { x: 96, y: 220, w: 768, h: 96, fontsize: 48 },
            };
            (templateData.user_templates ||= []).push(id);
          } else if (payload.action === "update") {
            templateData.templates[id] = {
              ...templateData.templates[payload.template], display_name: id,
            };
            if (payload.preview) {
              templateData.templates[id].preview = payload.preview;
              templateData.templates[id].background = payload.preview;
              templateData.templates[id].width = 320;
              templateData.templates[id].height = 180;
            }
            if (id !== payload.template) delete templateData.templates[payload.template];
          }
          templateData.current = payload.action === "create"
            ? id : payload.active_template === payload.template
              ? id : payload.active_template ?? id;
          return { status: "ok", template: id, active_template: templateData.current };
        }
        saved.push(payload);
        return { template: payload.template_name };
      },
    },
  };
  window.parent = window;
  const environment = vm.createContext({
    document,
    window,
    URLSearchParams,
    console,
    fetch: fetchImpl,
    createImageBitmap: async (blob) => ({
      width: blob?.width || 960,
      height: blob?.height || 540,
    }),
    setTimeout(callback) {
      const id = ++nextTimer;
      scheduledTimers.set(id, callback);
      return id;
    },
    clearTimeout(id) {
      scheduledTimers.delete(id);
    },
    FileReader: class {
      readAsDataURL(file) {
        this.result = file.dataUrl;
        this.onload();
      }
    },
  });
  vm.runInContext(script, environment);

  function pointer(type, x, y) {
    return canvasWrap.dispatch(type, { clientX: x, clientY: y, pointerId: 1 });
  }

  function keydown(key, target = null, modifiers = {}) {
    const event = {
      key,
      target,
      ...modifiers,
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
    };
    window.dispatch("keydown", event);
    return event;
  }

  function state() {
    const value = vm.runInContext("({ ...rect, fontSize, rotation, selected })", environment);
    return { ...value };
  }

  function evaluate(expression) {
    return vm.runInContext(expression, environment);
  }

  function setImageDataUrl(value, templateId = "test") {
    environment.currentImageDataUrlForTest = value;
    environment.boundTemplateIdForTest = templateId;
    vm.runInContext(
      "currentImageDataUrl = currentImageDataUrlForTest; boundTemplateId = boundTemplateIdForTest; editingTemplateId = boundTemplateIdForTest",
      environment,
    );
  }

  function flushTimers() {
    for (const [id, callback] of scheduledTimers) {
      scheduledTimers.delete(id);
      callback();
    }
  }

  return { canvas, canvasWrap, configRequests, deleteRequests, element, evaluate, flushTimers, keydown, lineDraws, listRequests, pointer, saved, setImageDataUrl, state, textDraws };
}

test("outside drag leaves the text box in place", () => {
  const editor = createEditor();
  const before = editor.state();
  editor.pointer("pointerdown", 20, 20);
  editor.pointer("pointermove", 500, 400);
  editor.pointer("pointerup", 500, 400);
  assert.deepEqual(editor.state(), before);
  assert.equal(editor.canvasWrap.capturedPointer, undefined);
});

test("toolbar is below the top bar and appears only while the frame is selected", () => {
  assert.match(html, /<header class="topbar">[\s\S]*?<\/header>\s*<div class="selection-toolbar"[\s\S]*?<div class="canvas-wrap">/);
  assert.match(html, /<div class="editor-header">\s*<header class="topbar">/);
  assert.match(html, /\.editor-header\s*\{[^}]*position: sticky;[^}]*top: 0;/);
  assert.match(html, /\.topbar\s*\{[^}]*display: grid;[^}]*grid-template-columns: minmax\(0, 1fr\) auto minmax\(0, 1fr\);/);
  assert.match(html, /\.selection-toolbar\s*\{[^}]*flex-wrap: nowrap;[^}]*width: max-content;[^}]*margin: 12px auto 0;[^}]*height: 54px;[^}]*overflow-x: auto;/);
  assert.doesNotMatch(html, /id="templateName"/);
  assert.doesNotMatch(html, /邀请函模版编辑器/);
  const toolbarMarkup = html.match(/<div class="selection-toolbar"[\s\S]*?<div class="canvas-wrap">/)?.[0];
  assert.doesNotMatch(toolbarMarkup, /id="(?:newTemplateBtn|existingTemplateBtn|imageInput)"/);
  assert.match(toolbarMarkup, /id="previewTextInput"/);
  assert.doesNotMatch(html, /<aside class="side">/);
  const editor = createEditor();
  const toolbar = editor.element("selectionToolbar");
  assert.equal(toolbar.classList.contains("visible"), false);
  assert.equal(toolbar.getAttribute("aria-hidden"), "true");
  assert.equal(toolbar.inert, true);
  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointerup", 480, 268);
  assert.equal(toolbar.classList.contains("visible"), true);
  assert.equal(toolbar.getAttribute("aria-hidden"), "false");
  assert.equal(toolbar.inert, false);
  editor.pointer("pointerdown", 20, 20);
  assert.equal(toolbar.classList.contains("visible"), false);
  assert.equal(toolbar.inert, true);
});

test("top bar shows template configuration and keeps canvas save separate", async () => {
  const editor = createEditor();
  await new Promise(setImmediate);
  assert.equal(editor.evaluate("boundTemplateId"), "");
  assert.doesNotMatch(html, /id="boundTemplateName"/);
  assert.match(html, /\.template-config-trigger button\s*\{[^}]*font-weight: 400;/);
  assert.equal(editor.element("saveBtn").disabled, true);
  editor.setImageDataUrl("data:image/png;base64,AA==", "spring");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved[0].template_name, "spring");
  assert.equal(editor.configRequests.length, 0);
  assert.match(html, /id="templateConfigBtn"[^>]*><svg class="config-icon"[^>]*><path d="M832 64H288[^>]*\/><\/svg><span>模版配置<\/span><\/button>/);
  assert.doesNotMatch(html, /id="(?:newTemplateBtn|existingTemplateBtn|templateSelect|templateNameInput|imageInput)"/);
});

test("first visit shows the sample without changing the active template", async () => {
  const data = {
    templates: {
      other: { display_name: "Other", layer: { x: 10 } },
      sample: { display_name: "样例", layer: { x: 200 } },
    },
    current: "other",
    first_visit: true,
  };
  const first = createEditor(data);
  assert.match(html, /\.editor-surface\s*\{[^}]*visibility: hidden;/);
  await new Promise(setImmediate);
  assert.equal(first.evaluate("currentTemplateName()"), "sample");
  assert.equal(first.evaluate("boundTemplateId"), "other");
  assert.equal(first.element("editorSurface").style.visibility, "visible");
  assert.equal(first.element("editorSurface").style.display, "");
  assert.equal(first.element("canvasEmptyState").hidden, true);

  const next = createEditor(data);
  await new Promise(setImmediate);
  assert.equal(next.evaluate("currentTemplateName()"), "other");
  assert.equal(next.evaluate("boundTemplateId"), "other");
});

test("later visits show the first listed template when none is active", async () => {
  const data = {
    templates: {
      first: { display_name: "First", layer: { x: 20 } },
      "样例": { display_name: "样例", layer: { x: 200 } },
    },
    current: "",
    first_visit: true,
  };
  const first = createEditor(data);
  await new Promise(setImmediate);
  assert.equal(first.evaluate("currentTemplateName()"), "样例");
  assert.equal(first.evaluate("boundTemplateId"), "");

  const next = createEditor(data);
  await new Promise(setImmediate);
  assert.equal(next.evaluate("currentTemplateName()"), "first");
  assert.equal(next.element("saveBtn").disabled, false);
});

test("an empty template list shows an empty state instead of a blank canvas", async () => {
  const editor = createEditor();
  await new Promise(setImmediate);
  assert.equal(editor.element("editorSurface").style.visibility, undefined);
  assert.equal(editor.element("editorSurface").style.display, "none");
  assert.equal(editor.element("canvasEmptyState").hidden, false);
  assert.equal(editor.element("saveBtn").disabled, true);
});

test("canvas save briefly shows a short success notice", async () => {
  const editor = createEditor();
  editor.setImageDataUrl("data:image/png;base64,AA==");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.element("status").textContent, "已保存");
  editor.flushTimers();
  assert.equal(editor.element("status").textContent, "");
});

test("drawer lists templates in a two-column grid with the create card last", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", preview: "data:image/png;base64,AA==" },
      second: { display_name: "Second", preview: "" },
    },
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  const cards = editor.element("templateGrid").children;
  assert.equal(cards.length, 3);
  assert.equal(cards[0].children[1].children[0].textContent, "First");
  assert.equal(cards[0].children[1].children[1].getAttribute("role"), "switch");
  assert.equal(cards[1].children[0].textContent, "暂无图片");
  assert.match(cards[2].className, /create/);
  assert.match(html, /\.template-drawer\s*\{[^}]*width: 440px;/);
  assert.match(html, /\.template-grid\s*\{[^}]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(html, /\.drawer-list\s*\{[^}]*overflow-y: auto;/);
});

test("drawer close and overlay discard metadata edits without requests", async () => {
  const editor = createEditor({
    templates: { first: { display_name: "First", preview: "" } }, current: "first",
  });
  await new Promise(setImmediate);
  const button = editor.element("templateConfigBtn");
  const overlay = editor.element("drawerOverlay");
  button.dispatch("click");
  editor.evaluate('selectDrawerTemplate("")');
  editor.element("drawerNameInput").value = "Draft";
  await editor.element("drawerCloseBtn").dispatch("click");
  assert.equal(overlay.hidden, true);
  assert.equal(editor.evaluate("boundTemplateId"), "first");
  assert.equal(editor.configRequests.length, 0);
  button.dispatch("click");
  editor.element("drawerNameInput").value = "Changed";
  await overlay.dispatch("click", { target: overlay });
  assert.equal(overlay.hidden, true);
  assert.equal(editor.configRequests.length, 0);
  button.dispatch("click");
  assert.equal(editor.element("drawerNameInput").value, "First");
  assert.equal(button.getAttribute("aria-expanded"), "true");
  editor.keydown("Escape");
  assert.equal(button.getAttribute("aria-expanded"), "false");
});

test("the template switch saves immediately and the next editor loads it", async () => {
  const data = {
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==" },
      second: { display_name: "Second", background: "data:image/png;base64,AA==" },
    },
    current: "first",
  };
  const editor = createEditor(data);
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  const firstSwitch = editor.element("templateGrid").children[0].children[1].children[1];
  assert.equal(firstSwitch.getAttribute("aria-checked"), "true");
  const secondSwitch = editor.element("templateGrid").children[1].children[1].children[1];
  await secondSwitch.dispatch("click", { stopPropagation() {} });
  assert.equal(editor.element("templateGrid").children[0].children[1].children[1].getAttribute("aria-checked"), "false");
  assert.equal(editor.element("templateGrid").children[1].children[1].children[1].getAttribute("aria-checked"), "true");
  assert.equal(editor.element("drawerNameInput").value, "Second");
  assert.equal(editor.evaluate("boundTemplateId"), "second");
  assert.deepEqual(editor.configRequests.map(({ action, template }) => [action, template]), [["bind", "second"]]);
  await editor.element("drawerCloseBtn").dispatch("click");
  assert.equal(editor.element("drawerOverlay").hidden, true);
  const next = createEditor(data);
  await new Promise(setImmediate);
  assert.equal(next.evaluate("currentTemplateName()"), "second");
});

test("clicking the enabled switch again clears every enabled template", async () => {
  const editor = createEditor({
    templates: {
      first: {
        display_name: "First", background: "data:image/png;base64,AA==",
      },
      second: {
        display_name: "Second", background: "data:image/png;base64,AA==",
      },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  const firstSwitch = editor.element("templateGrid").children[0].children[1].children[1];
  await firstSwitch.dispatch("click", { stopPropagation() {} });
  assert.equal(editor.evaluate("draftActiveId"), "");
  for (const card of editor.element("templateGrid").children.slice(0, 2)) {
    assert.equal(card.children[1].children[1].getAttribute("aria-checked"), "false");
  }
  assert.equal(editor.configRequests[0].active_template, "");
  assert.equal(editor.evaluate("boundTemplateId"), "");
  assert.equal(editor.evaluate("currentTemplateName()"), "first");
  await editor.element("drawerCloseBtn").dispatch("click");
  editor.element("templateConfigBtn").dispatch("click");
  for (const card of editor.element("templateGrid").children.slice(0, 2)) {
    assert.equal(card.children[1].children[1].getAttribute("aria-checked"), "false");
  }
});

test("failed immediate binding restores the previous enabled switch", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First" },
      second: { display_name: "Second" },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.evaluate('window.AstrBotPluginPage.apiPost = async () => { throw new Error("Bind failed"); }');
  const secondSwitch = editor.element("templateGrid").children[1].children[1].children[1];
  await secondSwitch.dispatch("click", { stopPropagation() {} });
  assert.equal(editor.evaluate("boundTemplateId"), "first");
  assert.equal(editor.element("templateGrid").children[0].children[1].children[1].getAttribute("aria-checked"), "true");
  assert.equal(editor.element("drawerError").textContent, "Bind failed");
});

test("drawer labels and inputs share a row", () => {
  assert.match(html, /\.drawer-field\s*\{[^}]*display: flex;[^}]*align-items: center;/);
  assert.match(html, /class="drawer-field"><span>模版名称<\/span><input id="drawerNameInput"/);
  assert.match(html, /class="drawer-field"><span>图片<\/span><input id="drawerPreviewInput"/);
});

test("editing a disabled card does not enable it when saved", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
      second: { display_name: "Second", background: "data:image/png;base64,AA==",
        layer: { x: 340, y: 180, w: 260, h: 70 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  await editor.element("templateGrid").children[1].dispatch("click");
  editor.element("drawerNameInput").value = "Edited second";
  editor.element("drawerNameInput").dispatch("input");
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.configRequests[0].action, "update");
  assert.equal(editor.configRequests[0].template, "second");
  assert.equal(editor.configRequests[0].active_template, "first");
  assert.equal(editor.evaluate("boundTemplateId"), "first");
  assert.equal(editor.evaluate("currentTemplateName()"), "Edited second");
  assert.equal(editor.state().x, 340);
});

test("clicking another card previews its canvas and close keeps it editable", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40 } },
      second: { display_name: "Second", background: "data:image/png;base64,AA==",
        layer: { x: 340, y: 180, w: 260, h: 70, fontsize: 36 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  await editor.element("templateGrid").children[1].dispatch("click");
  assert.equal(editor.state().x, 340);
  assert.equal(editor.element("drawerNameInput").value, "Second");
  assert.equal(editor.evaluate("boundTemplateId"), "first");
  assert.equal(editor.configRequests.length, 0);

  editor.element("drawerNameInput").value = "Uncommitted name";
  await editor.element("drawerCloseBtn").dispatch("click");
  assert.equal(editor.element("drawerOverlay").hidden, true);
  assert.equal(editor.state().x, 340);
  assert.equal(editor.evaluate("currentTemplateName()"), "second");
  assert.equal(editor.configRequests.length, 0);
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved[0].template_name, "second");
});

test("clicking the overlay keeps the selected card's canvas without saving config", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
      second: { display_name: "Second", background: "data:image/png;base64,AA==",
        layer: { x: 340, y: 180, w: 260, h: 70 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  await editor.element("templateGrid").children[1].dispatch("click");
  const overlay = editor.element("drawerOverlay");
  overlay.dispatch("click", { target: overlay });
  await new Promise(setImmediate);
  assert.equal(overlay.hidden, true);
  assert.equal(editor.state().x, 340);
  assert.equal(editor.evaluate("currentTemplateName()"), "second");
  assert.equal(editor.configRequests.length, 0);
});

test("Escape restores unsaved canvas edits after previewing another card", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40 } },
      second: { display_name: "Second", background: "data:image/png;base64,AA==",
        layer: { x: 340, y: 180, w: 260, h: 70, fontsize: 36 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.pointer("pointerdown", 200, 140);
  editor.pointer("pointermove", 220, 150);
  editor.pointer("pointerup", 220, 150);
  const before = editor.state();
  assert.equal(editor.element("undoBtn").disabled, false);

  editor.element("templateConfigBtn").dispatch("click");
  await editor.element("templateGrid").children[1].dispatch("click");
  assert.equal(editor.state().x, 340);
  editor.keydown("Escape");
  assert.deepEqual(editor.state(), before);
  assert.equal(editor.evaluate("currentTemplateName()"), "first");
  assert.equal(editor.evaluate("backgroundColor"), "#ffffff");
  assert.equal(editor.element("undoBtn").disabled, false);
  assert.equal(editor.configRequests.length, 0);
});

test("delete requires confirmation and cancellation leaves the template intact", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  assert.equal(editor.element("drawerDeleteBtn").disabled, false);
  editor.element("drawerDeleteBtn").dispatch("click");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, false);
  assert.match(editor.element("deleteConfirmMessage").textContent, /First/);
  assert.equal(editor.deleteRequests.length, 0);
  editor.element("deleteCancelBtn").dispatch("click");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, true);
  editor.element("drawerDeleteBtn").dispatch("click");
  editor.keydown("Escape");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, true);
  assert.equal(editor.element("templateGrid").children.length, 2);
  assert.equal(editor.deleteRequests.length, 0);
  assert.doesNotMatch(html, /id="drawerCancelBtn"/);
  assert.match(html, /id="drawerConfirmBtn"[^>]*>保存<\/button>[\s\S]*?id="drawerDeleteBtn"[^>]*>删除<\/button>/);
});

test("delete failure keeps the confirmation open and allows cancellation", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerDeleteBtn").dispatch("click");
  editor.evaluate('pluginApiPost = async () => { throw new Error("Delete failed") }');
  await editor.element("deleteConfirmBtn").dispatch("click");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, false);
  assert.equal(editor.element("deleteConfirmError").textContent, "Delete failed");
  assert.equal(editor.element("deleteConfirmBtn").disabled, false);
  assert.equal(editor.element("deleteCancelBtn").disabled, false);
  assert.equal(editor.deleteRequests.length, 0);
  editor.element("deleteCancelBtn").dispatch("click");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, true);
});

test("delete falls back to the previously registered route", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerDeleteBtn").dispatch("click");
  editor.evaluate(`pluginApiPost = async (endpoint, body) => {
    if (endpoint === "editor/template-config") {
      return { status: "error", message: "Invalid template action." };
    }
    return window.AstrBotPluginPage.apiPost(endpoint, body);
  }`);
  await editor.element("deleteConfirmBtn").dispatch("click");
  assert.equal(editor.deleteRequests.length, 1);
  assert.equal(editor.deleteRequests[0].template, "first");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, true);
  assert.equal(editor.evaluate("currentTemplateName()"), "");
});

test("delete explains when neither route is loaded", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerDeleteBtn").dispatch("click");
  editor.evaluate(`pluginApiPost = async (endpoint) => ({ status: "error",
    message: endpoint === "editor/template-config"
      ? "Invalid template action." : "未找到该路由" })`);
  await editor.element("deleteConfirmBtn").dispatch("click");
  assert.equal(editor.element("deleteConfirmOverlay").hidden, false);
  assert.equal(editor.element("deleteConfirmError").textContent,
    "删除接口未加载，请重载插件后重试。");
  assert.equal(editor.deleteRequests.length, 0);
});

test("confirmed deletion clears the active template and leaves the drawer open", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  const listCount = editor.listRequests.length;
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerDeleteBtn").dispatch("click");
  await editor.element("deleteConfirmBtn").dispatch("click");
  assert.deepEqual(editor.deleteRequests.map(({ template }) => template), ["first"]);
  assert.equal(editor.listRequests.length, listCount);
  assert.equal(editor.element("deleteConfirmOverlay").hidden, true);
  assert.equal(editor.element("drawerOverlay").hidden, false);
  assert.equal(editor.element("templateGrid").children.length, 1);
  assert.equal(editor.element("drawerDeleteBtn").disabled, true);
  assert.equal(editor.evaluate("boundTemplateId"), "");
  assert.equal(editor.evaluate("currentTemplateName()"), "");
  assert.equal(editor.element("saveBtn").disabled, true);
  editor.element("drawerCloseBtn").dispatch("click");
  await new Promise(setImmediate);
  assert.equal(editor.element("drawerOverlay").hidden, true);
  assert.equal(editor.evaluate("currentTemplateName()"), "");
});

test("deleting a non-active template keeps the active template", async () => {
  const editor = createEditor({
    templates: {
      first: { display_name: "First", background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80 } },
      second: { display_name: "Second", background: "data:image/png;base64,AA==",
        layer: { x: 340, y: 180, w: 260, h: 70 } },
    },
    current: "first",
  });
  await new Promise(setImmediate);
  const listCount = editor.listRequests.length;
  editor.element("templateConfigBtn").dispatch("click");
  await editor.element("templateGrid").children[1].dispatch("click");
  editor.element("drawerDeleteBtn").dispatch("click");
  await editor.element("deleteConfirmBtn").dispatch("click");
  assert.equal(editor.deleteRequests[0].template, "second");
  assert.equal(editor.listRequests.length, listCount);
  assert.equal(editor.evaluate("boundTemplateId"), "first");
  assert.equal(editor.evaluate("currentTemplateName()"), "first");
  assert.equal(editor.state().x, 100);
  assert.equal(editor.element("templateGrid").children.length, 2);
});

test("zoom slider has an accessible name without visible text", () => {
  assert.match(html, /<div class="zoom-control">\s*<input id="zoomInput"[^>]*aria-label="缩放"/);
  assert.doesNotMatch(html, /<label class="zoom-control">|<div class="zoom-control">\s*缩放/);
});

test("a template without an uploaded image can be edited and saved", async () => {
  const editor = createEditor({
    templates: {
      image: { display_name: "Image", background: "data:image/png;base64,AA==",
        layer: { id: "name", x: 100, y: 100, w: 300, h: 80 } },
      default: { display_name: "Default", width: 1200, height: 675,
        background_color: "#f7f2ea", layer: { id: "title", x: 120, y: 120,
          w: 960, h: 90, fontsize: 64 } },
    },
    current: "image",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  await editor.element("templateGrid").children[1].dispatch("click");
  await editor.element("drawerCloseBtn").dispatch("click");
  assert.equal(editor.evaluate("bitmap"), null);
  assert.equal(editor.evaluate("backgroundColor"), "#f7f2ea");
  assert.equal(editor.element("saveBtn").disabled, false);
  editor.element("previewTextInput").value = "Edited";
  editor.element("previewTextInput").dispatch("input");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved[0].template_name, "default");
  assert.equal(editor.saved[0].save_layer, true);
  assert.equal(editor.saved[0].layer, "title");
  assert.equal(editor.saved[0].image, undefined);
  assert.equal(editor.saved[0].default, "Edited");
});

test("a slow earlier template load cannot replace a newer card selection", async () => {
  let releaseSlow;
  const editor = createEditor({
    templates: {
      first: { background: "first", layer: { x: 100, y: 100, w: 300, h: 80 } },
      slow: { background: "slow", layer: { x: 250, y: 100, w: 300, h: 80 } },
      last: { background: "last", layer: { x: 400, y: 100, w: 300, h: 80 } },
    },
    current: "first",
  }, async (url) => ({
    blob: async () => {
      if (url === "slow") await new Promise((resolve) => { releaseSlow = resolve; });
      return {};
    },
  }));
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  const slowLoad = editor.element("templateGrid").children[1].dispatch("click");
  await editor.element("templateGrid").children[2].dispatch("click");
  assert.equal(editor.state().x, 400);
  releaseSlow();
  await slowLoad;
  assert.equal(editor.state().x, 400);
  await editor.element("drawerCloseBtn").dispatch("click");
  assert.equal(editor.evaluate("currentTemplateName()"), "last");
});

test("editing an existing template updates metadata and previews a selected file locally", async () => {
  const editor = createEditor({
    templates: { default: { display_name: "Before", preview: "data:image/png;base64,AA==",
      background: "data:image/png;base64,AA==" } },
    current: "default",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  assert.equal(editor.element("drawerNameInput").value, "Before");
  assert.equal(editor.element("drawerPreviewImage").hidden, false);
  editor.element("drawerNameInput").value = "After";
  editor.element("drawerNameInput").dispatch("input");
  const input = editor.element("drawerPreviewInput");
  input.files = [{ dataUrl: "data:image/png;base64,BBBB" }];
  await input.dispatch("change");
  assert.equal(editor.element("drawerPreviewImage").src, "data:image/png;base64,BBBB");
  assert.equal(editor.configRequests.length, 0);
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.configRequests[0].action, "update");
  assert.equal(editor.configRequests[0].template, "default");
  assert.equal(editor.configRequests[0].display_name, "After");
  assert.equal(editor.configRequests[0].preview, "data:image/png;base64,BBBB");
  assert.equal(editor.evaluate("templateDetails.After.display_name"), "After");
  assert.equal(editor.saved.length, 0);
});

test("saving an uploaded image replaces the canvas without a second save", async () => {
  const uploaded = "data:image/png;base64,BBBB";
  const editor = createEditor({
    templates: {
      default: { display_name: "default", width: 1200, height: 675,
        background_color: "#f7f2ea",
        layer: { id: "title", x: 120, y: 120, w: 960, h: 90, fontsize: 64 } },
    },
    current: "default",
  }, async (url) => ({ blob: async () =>
    url === uploaded ? { width: 320, height: 180 } : {} }));
  await new Promise(setImmediate);
  assert.equal(editor.evaluate("bitmap"), null);
  editor.element("templateConfigBtn").dispatch("click");
  const input = editor.element("drawerPreviewInput");
  input.files = [{ dataUrl: uploaded }];
  await input.dispatch("change");
  assert.equal(editor.configRequests.length, 0);
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.configRequests[0].action, "update");
  assert.equal(editor.configRequests[0].preview, uploaded);
  assert.equal(editor.evaluate("currentImageDataUrl"), uploaded);
  assert.equal(editor.evaluate("bitmap.width"), 320);
  assert.equal(editor.canvas.width, 320);
  assert.equal(editor.canvas.height, 180);
  assert.equal(editor.element("drawerOverlay").hidden, true);
  assert.equal(editor.saved.length, 0);
});

test("creating a template with an image displays that image as its canvas", async () => {
  const uploaded = "data:image/png;base64,CCCC";
  const editor = createEditor({ templates: {} }, async () => ({
    blob: async () => ({ width: 320, height: 180 }),
  }));
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New image";
  editor.element("drawerNameInput").dispatch("input");
  const input = editor.element("drawerPreviewInput");
  input.files = [{ dataUrl: uploaded }];
  await input.dispatch("change");
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.configRequests[0].action, "create");
  assert.equal(editor.configRequests[0].preview, uploaded);
  assert.equal(editor.evaluate("currentTemplateName()"), "New image");
  assert.equal(editor.evaluate("currentImageDataUrl"), uploaded);
  assert.equal(editor.canvas.width, 320);
  assert.equal(editor.canvas.height, 180);
});

test("renaming default without uploading an image preserves its preview", async () => {
  const preview = "data:image/png;base64,AA==";
  const editor = createEditor({
    templates: {
      default: {
        display_name: "default",
        preview,
        background: preview,
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40 },
      },
    },
    current: "default",
  });
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New name";
  editor.element("drawerNameInput").dispatch("input");
  assert.equal(editor.element("drawerConfirmBtn").disabled, false);
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.configRequests[0].action, "update");
  assert.equal(editor.configRequests[0].template, "default");
  assert.equal(editor.configRequests[0].preview, undefined);
  assert.equal(editor.evaluate("templateDetails['New name'].display_name"), "New name");
  assert.equal(editor.element("drawerOverlay").hidden, true);
  assert.equal(editor.saved.length, 0);

  editor.element("templateConfigBtn").dispatch("click");
  assert.equal(editor.element("drawerPreviewImage").src, preview);
});

test("new template requires a name but accepts no preview image", async () => {
  const editor = createEditor();
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  assert.equal(editor.element("drawerDeleteBtn").disabled, true);
  assert.equal(editor.element("drawerConfirmBtn").disabled, true);
  assert.equal(editor.element("drawerConfirmHint").title, "请输入模版名称");
  assert.equal(editor.element("drawerPreviewPlaceholder").hidden, false);
  assert.match(html, /id="drawerConfirmBtn"[^>]*>保存<\/button>/);
  assert.match(html, /<label class="drawer-field"><span>图片<\/span><input id="drawerPreviewInput"/);
  assert.match(html, /id="drawerPreviewPlaceholder">暂无图片<\/span>/);
  editor.element("drawerNameInput").value = "New invitation";
  editor.element("drawerNameInput").dispatch("input");
  assert.equal(editor.element("drawerConfirmBtn").disabled, false);
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.configRequests[0].action, "create");
  assert.equal(editor.configRequests[0].preview, undefined);
  assert.equal(editor.evaluate("boundTemplateId"), "New invitation");
  assert.equal(editor.element("saveBtn").disabled, false);
  assert.equal(editor.evaluate("currentTemplateName()"), "New invitation");
  assert.equal(editor.element("drawerOverlay").hidden, true);
});

test("failed template configuration keeps the drawer open and restores controls", async () => {
  const editor = createEditor();
  await new Promise(setImmediate);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New";
  editor.element("drawerNameInput").dispatch("input");
  editor.evaluate('pluginApiPost = async () => { throw new Error("Save failed") }');
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.element("drawerOverlay").hidden, false);
  assert.equal(editor.element("drawerError").textContent, "Save failed");
  assert.equal(editor.element("drawerConfirmBtn").disabled, false);
  assert.equal(editor.element("drawerDeleteBtn").disabled, true);
  assert.equal(editor.configRequests.length, 0);
  await editor.element("drawerCloseBtn").dispatch("click");
  assert.equal(editor.element("drawerOverlay").hidden, true);
});

test("undo and redo remain at the left of the top bar", () => {
  assert.match(html, /<header class="topbar">\s*<div class="topbar-actions">\s*<div class="history-controls"[\s\S]*?id="undoBtn"[\s\S]*?id="redoBtn"/);
});

test("undo and redo restore box geometry and branch after a new edit", () => {
  const editor = createEditor();
  assert.equal(editor.element("undoBtn").disabled, true);
  assert.equal(editor.element("redoBtn").disabled, true);

  const before = editor.state();
  editor.pointer("pointerdown", 150, 250);
  editor.pointer("pointermove", 180, 270);
  editor.pointer("pointerup", 180, 270);
  assert.equal(editor.state().x, before.x + 30);
  assert.equal(editor.element("undoBtn").disabled, false);
  editor.element("undoBtn").dispatch("click");
  assert.equal(editor.state().x, before.x);
  assert.equal(editor.state().y, before.y);
  assert.equal(editor.element("redoBtn").disabled, false);
  editor.element("redoBtn").dispatch("click");
  assert.equal(editor.state().x, before.x + 30);
  assert.equal(editor.state().y, before.y + 20);
  editor.element("undoBtn").dispatch("click");
  editor.pointer("pointerdown", before.x + 30, before.y + 20);
  editor.pointer("pointermove", before.x + 50, before.y + 10);
  editor.pointer("pointerup", before.x + 50, before.y + 10);
  assert.equal(editor.element("redoBtn").disabled, true);
  editor.element("redoBtn").dispatch("click");
  assert.equal(editor.state().x, before.x + 20);
  assert.equal(editor.state().y, before.y - 10);
});

test("undo and redo restore text, font styles, and orientation", () => {
  const editor = createEditor();
  const preview = editor.element("previewTextInput");
  preview.value = "First";
  preview.dispatch("input");
  assert.equal(editor.evaluate("editorSnapshot().previewText"), "First");
  assert.deepEqual(Array.from(editor.evaluate("history.map(item => item.previewText)")), ["Name preview", "First"]);
  preview.value = "Second";
  preview.dispatch("input");
  assert.deepEqual(Array.from(editor.evaluate("history.map(item => item.previewText)")), ["Name preview", "First", "Second"]);
  editor.element("boldBtn").dispatch("click");
  editor.element("alignmentModeBtn").dispatch("click");
  assert.deepEqual(
    JSON.parse(editor.evaluate("JSON.stringify(history.map(item => [item.previewText, item.orientation, item.textStyles.bold]))")),
    [["Name preview", "horizontal", false], ["First", "horizontal", false],
      ["Second", "horizontal", false], ["Second", "horizontal", true],
      ["Second", "vertical", true]],
  );

  editor.element("undoBtn").dispatch("click");
  assert.equal(editor.evaluate("orientation"), "horizontal");
  assert.equal(editor.evaluate("textStyles.bold"), true);
  editor.element("undoBtn").dispatch("click");
  assert.equal(editor.evaluate("textStyles.bold"), false);
  editor.element("undoBtn").dispatch("click");
  assert.equal(editor.element("previewTextInput").value, "First");

  editor.element("redoBtn").dispatch("click");
  assert.equal(editor.element("previewTextInput").value, "Second");
  editor.element("redoBtn").dispatch("click");
  assert.equal(editor.evaluate("textStyles.bold"), true);
  editor.element("redoBtn").dispatch("click");
  assert.equal(editor.evaluate("orientation"), "vertical");
});

test("loading another template resets undo and redo history", async () => {
  const editor = createEditor({
    templates: {
      other: {
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40 },
      },
      saved: {
        background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40 },
      },
    },
    user_templates: ["saved"],
    current: "other",
  });
  await new Promise(setImmediate);
  const before = editor.state();
  editor.pointer("pointerdown", 200, 140);
  editor.pointer("pointermove", 220, 140);
  editor.pointer("pointerup", 220, 140);
  assert.equal(editor.element("undoBtn").disabled, false);

  editor.element("templateConfigBtn").dispatch("click");
  editor.evaluate('selectDrawerTemplate("saved")');
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.element("undoBtn").disabled, true);
  assert.equal(editor.element("redoBtn").disabled, true);
  assert.equal(editor.state().x, 100);
  editor.element("undoBtn").dispatch("click");
  assert.equal(editor.state().x, 100);
  assert.notEqual(editor.state().x, before.x + 20);
});

test("prefill text replaces the canvas preview as it is typed", () => {
  const editor = createEditor();
  const preview = editor.element("previewTextInput");
  assert.equal(editor.textDraws.at(-1).text, "Name preview");
  preview.value = "Guest name";
  preview.dispatch("input");
  assert.equal(editor.textDraws.at(-1).text, "Guest name");
  assert.equal(editor.state().h, editor.evaluate("textSize().h"));
  preview.value = "";
  preview.dispatch("input");
  assert.equal(editor.textDraws.at(-1).text, "");
});

test("formatting toolbar uses one row of functional groups", () => {
  const toolbar = html.match(/<div class="selection-toolbar"[\s\S]*?<div class="canvas-wrap">/)?.[0];
  assert.match(html, /\.selection-toolbar\s*\{[^}]*flex-wrap: nowrap;/);
  assert.match(html, /@media \(max-width: 900px\)\s*\{\s*\.selection-toolbar\s*\{\s*height: 70px;/);
  assert.match(html, /\.format-group\s*\{[^}]*border-right: 1px solid var\(--line\);/);
  assert.doesNotMatch(toolbar, /<p class="group-title">|<label(?:\s|>)/);
  assert.match(toolbar, /id="alignmentModeLabel" hidden/);
  for (const group of ["文本内容", "字体设置", "字形设置", "排版与对齐"]) {
    assert.match(toolbar, new RegExp(`aria-label="${group}"`));
  }
  for (const [id, label] of [
    ["previewTextInput", "文本预填"], ["fontInput", "字体"],
    ["fontSizeInput", "字号"], ["colorInput", "颜色"],
  ]) {
    assert.match(toolbar, new RegExp(`id="${id}"[^>]*title="${label}"[^>]*aria-label="${label}"`));
  }
  for (const id of ["boldBtn", "italicBtn", "underlineBtn", "strikethroughBtn", "alignControl"]) {
    assert.match(toolbar, new RegExp(`id="${id}"`));
  }
});

test("text style buttons update preview and save all formatting values", async () => {
  const editor = createEditor();
  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointerup", 480, 268);
  editor.element("fontInput").value = "simhei";
  editor.element("fontInput").dispatch("change");
  editor.element("fontSizeInput").value = "36";
  editor.element("fontSizeInput").dispatch("input");
  for (const style of ["bold", "italic", "underline", "strikethrough"]) {
    const button = editor.element(`${style}Btn`);
    button.dispatch("click");
    assert.equal(button.classList.contains("active"), true);
    assert.equal(button.getAttribute("aria-pressed"), "true");
  }
  const preview = editor.element("previewTextInput");
  preview.value = "Sample";
  preview.dispatch("input");
  assert.equal(editor.textDraws.at(-1).text, "Sample");
  assert.match(editor.textDraws.at(-1).font, /^italic bold /);
  assert.ok(editor.lineDraws.at(-1).length >= 4);
  editor.setImageDataUrl("data:image/png;base64,AA==", "styled");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved.length, 1);
  for (const style of ["bold", "italic", "underline", "strikethrough"]) {
    assert.equal(editor.saved[0][style], true);
  }
  assert.equal(editor.saved[0].default, "Sample");
  assert.equal(editor.saved[0].font, "simhei");
  assert.equal(editor.saved[0].fontsize, "36");

  editor.element("strikethroughBtn").dispatch("click");
  assert.equal(editor.element("strikethroughBtn").getAttribute("aria-pressed"), "false");
});

test("saved formatting and prefill are restored in the editor", async () => {
  const editor = createEditor({
    templates: {
      styled: {
        background: "data:image/png;base64,AA==",
        layer: {
          x: 100, y: 100, w: 300, h: 80, fontsize: 40, default: "Guest",
          bold: true, italic: true, underline: true, strikethrough: true,
        },
      },
    },
    user_templates: ["styled"],
    current: "styled",
  });
  await new Promise(setImmediate);
  assert.equal(editor.element("previewTextInput").value, "Guest");
  for (const style of ["bold", "italic", "underline", "strikethrough"]) {
    assert.equal(editor.element(`${style}Btn`).getAttribute("aria-pressed"), "true");
  }
  assert.equal(editor.textDraws.at(-1).text, "Guest");
});

test("orientation button switches the shared alignment control and vertical preview", async () => {
  const editor = createEditor();
  const toggle = editor.element("alignmentModeBtn");
  assert.equal(editor.element("alignControl").hidden, false);
  assert.equal(editor.element("valignControl").hidden, true);
  toggle.dispatch("click");
  assert.equal(editor.evaluate("orientation"), "vertical");
  assert.equal(toggle.getAttribute("aria-pressed"), "true");
  assert.equal(toggle.getAttribute("aria-label"), "切换为横版文字");
  assert.equal(editor.element("alignmentModeLabel").textContent, "竖版文字");
  assert.equal(editor.element("alignControl").hidden, true);
  assert.equal(editor.element("valignControl").hidden, false);
  const glyphs = editor.textDraws.slice(-12);
  assert.equal(glyphs.map((draw) => draw.text).join(""), "Name preview");
  assert.ok(glyphs.every((draw) => draw.x === glyphs[0].x));
  assert.ok(glyphs.every((draw, index) => index === 0 || draw.y > glyphs[index - 1].y));
  assert.ok(editor.state().h > editor.state().w);

  editor.setImageDataUrl("data:image/png;base64,AA==", "vertical");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved[0].orientation, "vertical");

  toggle.dispatch("click");
  assert.equal(editor.evaluate("orientation"), "horizontal");
  assert.equal(toggle.getAttribute("aria-pressed"), "false");
  assert.equal(editor.element("alignControl").hidden, false);
  assert.equal(editor.element("valignControl").hidden, true);
  assert.equal(editor.element("selectionBox").classList.contains("vertical"), false);
  assert.equal(editor.textDraws.at(-1).text, "Name preview");
});

test("vertical preview wraps into columns from right to left", () => {
  const editor = createEditor();
  editor.element("alignmentModeBtn").dispatch("click");
  editor.evaluate("rect.h = 120; rect.w = 250; draw()");
  const input = editor.element("previewTextInput");
  input.value = "ABCDEFG";
  input.dispatch("input");
  const glyphs = editor.textDraws.slice(-7);
  assert.equal(glyphs.map((draw) => draw.text).join(""), "ABCDEFG");
  assert.ok(glyphs[0].y < glyphs[1].y);
  assert.ok(glyphs[2].x < glyphs[0].x);
  assert.ok(glyphs[4].x < glyphs[2].x);
});

test("vertical alignment changes glyph position without losing horizontal alignment", async () => {
  const editor = createEditor();
  editor.element("alignControl").dispatch("click", {
    target: { closest: () => ({ dataset: { value: "right" } }) },
  });
  editor.element("alignmentModeBtn").dispatch("click");
  const firstY = editor.textDraws.at(-12).y;
  editor.element("valignControl").dispatch("click", {
    target: { closest: () => ({ dataset: { value: "bottom" } }) },
  });
  assert.ok(editor.textDraws.at(-12).y > firstY);
  assert.equal(editor.evaluate("textAlign"), "right");
  assert.equal(editor.evaluate("textValign"), "bottom");
  editor.setImageDataUrl("data:image/png;base64,AA==", "aligned");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved[0].align, "right");
  assert.equal(editor.saved[0].valign, "bottom");
  editor.element("alignmentModeBtn").dispatch("click");
  assert.equal(editor.evaluate("textAlign"), "right");
  assert.equal(editor.evaluate("textValign"), "bottom");
});

test("existing vertical templates restore their alignment mode", async () => {
  const editor = createEditor({
    templates: {
      saved: {
        background: "data:image/png;base64,AA==",
        layer: {
          x: 100, y: 50, w: 80, h: 300, fontsize: 40,
          align: "right", valign: "bottom", orientation: "vertical",
        },
      },
    },
    user_templates: ["saved"],
    current: "saved",
  });
  await new Promise(setImmediate);
  assert.equal(editor.evaluate("orientation"), "vertical");
  assert.equal(editor.element("valignControl").hidden, false);
  assert.equal(editor.element("alignControl").hidden, true);
  assert.equal(editor.evaluate("textAlign"), "right");
  assert.equal(editor.evaluate("textValign"), "bottom");
});

test("zoom changes displayed size and percentage without changing template coordinates", () => {
  const editor = createEditor();
  const before = editor.state();
  const zoomInput = editor.element("zoomInput");
  zoomInput.value = "150";
  zoomInput.dispatch("input");
  assert.equal(editor.element("zoomValue").textContent, "150%");
  assert.equal(editor.element("editorSurface").style.width, "1440px");
  assert.deepEqual(editor.state(), before);
  zoomInput.value = "50";
  zoomInput.dispatch("input");
  assert.equal(editor.element("zoomValue").textContent, "50%");
  assert.equal(editor.element("editorSurface").style.width, "480px");
});

test("pointer dragging uses displayed canvas coordinates after zoom", () => {
  const editor = createEditor();
  editor.element("zoomInput").value = "50";
  editor.element("zoomInput").dispatch("input");
  editor.canvas.clientWidth = 480;
  editor.canvas.clientHeight = 270;
  const before = editor.state();
  editor.pointer("pointerdown", 240, 134);
  editor.pointer("pointermove", 255, 144);
  editor.pointer("pointerup", 255, 144);
  assert.equal(editor.state().x, before.x + 30);
  assert.equal(editor.state().y, before.y + 20);
});

test("mouse dragging works at 200% after scrolling both axes", () => {
  const editor = createEditor();
  editor.element("zoomInput").value = "200";
  editor.element("zoomInput").dispatch("input");
  editor.canvas.clientWidth = 1920;
  editor.canvas.clientHeight = 1080;
  editor.canvas.getBoundingClientRect = () => ({
    left: -400, top: -100, right: 1520, bottom: 980,
  });
  const before = editor.state();
  editor.pointer("pointerdown", 560, 436);
  editor.pointer("pointermove", 580, 446);
  editor.pointer("pointerup", 580, 446);
  assert.equal(editor.state().x, before.x + 10);
  assert.equal(editor.state().y, before.y + 5);
});

test("the horizontal scrollbar stays below the canvas viewport", () => {
  assert.match(html, /\.shell\s*\{[^}]*height: 100vh;[^}]*overflow: hidden;/);
  assert.match(html, /\.stage\s*\{[^}]*grid-template-rows: auto minmax\(0, 1fr\) 18px;/);
  assert.match(html, /\.canvas-wrap\s*\{[^}]*min-height: 0;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;/);
  assert.match(html, /\.horizontal-scroll\s*\{[^}]*overflow-x: scroll;/);
  assert.match(html, /<div class="canvas-wrap">[\s\S]*?<\/div>\s*<div class="horizontal-scroll"/);
  assert.match(html, /\.editor-surface\s*\{[^}]*flex: none;/);
});

test("the fixed horizontal scrollbar follows zoom and scrolls the canvas", () => {
  const editor = createEditor();
  const track = editor.element("horizontalScroll");
  const content = editor.element("horizontalScrollContent");
  editor.canvasWrap.clientWidth = 1065;
  editor.canvasWrap.scrollWidth = 2050;
  editor.element("zoomInput").value = "200";
  editor.element("zoomInput").dispatch("input");
  assert.equal(track.style.width, "1065px");
  assert.equal(content.style.width, "2050px");

  track.scrollLeft = 320;
  track.dispatch("scroll");
  assert.equal(editor.canvasWrap.scrollLeft, 320);
  editor.canvasWrap.scrollLeft = 110;
  editor.canvasWrap.dispatch("scroll");
  assert.equal(track.scrollLeft, 110);
});

test("zoom remains a display-only setting after loading an image", async () => {
  const editor = createEditor();
  editor.element("zoomInput").value = "150";
  editor.element("zoomInput").dispatch("input");
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New";
  editor.element("drawerNameInput").dispatch("input");
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.element("editorSurface").style.width, `${editor.canvas.width * 1.5}px`);
  assert.equal(editor.element("zoomValue").textContent, "150%");
});

test("image fitting uses the space below the fixed header", async () => {
  const editor = createEditor();
  editor.canvasWrap.clientWidth = 800;
  editor.canvasWrap.clientHeight = 500;
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New";
  editor.element("drawerNameInput").dispatch("input");
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.ok(editor.canvas.width <= 680);
  assert.ok(editor.canvas.height <= 380);
});

test("creating a template keeps the selected toolbar open", async () => {
  const editor = createEditor();
  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointerup", 480, 268);
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New";
  editor.element("drawerNameInput").dispatch("input");
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.state().selected, true);
  assert.equal(editor.element("selectionToolbar").classList.contains("visible"), true);
});

test("switching templates keeps the selected toolbar open", async () => {
  const editor = createEditor({
    templates: {
      saved: {
        background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40 },
      },
      other: {
        layer: { x: 300, y: 100, w: 300, h: 80, fontsize: 40 },
      },
    },
    user_templates: ["saved"],
    current: "saved",
  });
  await new Promise(setImmediate);
  editor.pointer("pointerdown", 200, 140);
  editor.pointer("pointerup", 200, 140);
  editor.element("templateConfigBtn").dispatch("click");
  editor.evaluate('selectDrawerTemplate("other")');
  await editor.element("drawerConfirmBtn").dispatch("click");
  assert.equal(editor.state().selected, true);
  assert.equal(editor.element("selectionToolbar").classList.contains("visible"), true);
});

test("moving the box preserves its dimensions and font size", () => {
  const editor = createEditor();
  const before = editor.state();
  editor.pointer("pointerdown", 150, 250);
  editor.pointer("pointermove", 180, 270);
  editor.pointer("pointerup", 180, 270);
  const moved = editor.state();
  assert.equal(moved.x, before.x + 30);
  assert.equal(moved.y, before.y + 20);
  assert.equal(moved.w, before.w);
  assert.equal(moved.h, before.h);
  assert.equal(moved.fontSize, before.fontSize);
});

test("the box can move beyond each image edge", () => {
  for (const [dx, dy, edge] of [
    [-120, 0, "left"],
    [120, 0, "right"],
    [0, -240, "top"],
    [0, 280, "bottom"],
  ]) {
    const editor = createEditor();
    const before = editor.state();
    const centerX = before.x + before.w / 2;
    const centerY = before.y + before.h / 2;
    editor.pointer("pointerdown", centerX, centerY);
    editor.pointer("pointermove", centerX + dx, centerY + dy);
    editor.pointer("pointerup", centerX + dx, centerY + dy);
    const after = editor.state();
    assert.equal(after.x, before.x + dx, edge);
    assert.equal(after.y, before.y + dy, edge);
    assert.equal(editor.element("selectionBox").style.left, `${after.x / 960 * 100}%`);
    assert.equal(editor.element("selectionBox").style.top, `${after.y / 540 * 100}%`);
  }
});

test("a box outside the image can be dragged again", () => {
  const editor = createEditor();
  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointermove", 360, 268);
  editor.pointer("pointerup", 360, 268);
  assert.equal(editor.state().x, -24);
  editor.pointer("pointerdown", -12, 268);
  editor.pointer("pointermove", 8, 268);
  editor.pointer("pointerup", 8, 268);
  assert.equal(editor.state().x, -4);
});

test("dragging stops at all four gray area edges", () => {
  for (const [dx, dy, expectedX, expectedY] of [
    [-2000, 0, -60, 240],
    [2000, 0, 252, 240],
    [0, -2000, 96, -160],
    [0, 2000, 96, 644],
  ]) {
    const editor = createEditor();
    editor.pointer("pointerdown", 480, 268);
    editor.pointer("pointermove", 480 + dx, 268 + dy);
    editor.pointer("pointerup", 480 + dx, 268 + dy);
    assert.equal(editor.state().x, expectedX);
    assert.equal(editor.state().y, expectedY);
  }
});

test("arrow keys and WASD move the selected box by one unit", () => {
  const editor = createEditor();
  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointerup", 480, 268);
  const before = editor.state();
  for (const [key, dx, dy] of [
    ["ArrowLeft", -1, 0], ["a", -1, 0],
    ["ArrowRight", 1, 0], ["D", 1, 0],
    ["ArrowUp", 0, -1], ["w", 0, -1],
    ["ArrowDown", 0, 1], ["S", 0, 1],
  ]) {
    const previous = editor.state();
    const event = editor.keydown(key);
    assert.equal(event.defaultPrevented, true, key);
    assert.equal(editor.state().x, previous.x + dx, key);
    assert.equal(editor.state().y, previous.y + dy, key);
  }
  assert.equal(editor.state().x, before.x);
  assert.equal(editor.state().y, before.y);
});

test("keyboard movement does not interfere with typing or an unselected box", () => {
  const editor = createEditor();
  const before = editor.state();
  assert.equal(editor.keydown("ArrowLeft").defaultPrevented, false);
  assert.equal(editor.state().x, before.x);

  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointerup", 480, 268);
  for (const key of ["a", "ArrowLeft"]) {
    const event = editor.keydown(key, { closest: () => ({}) });
    assert.equal(event.defaultPrevented, false);
    assert.equal(editor.state().x, before.x);
  }
  assert.equal(editor.keydown("a", null, { ctrlKey: true }).defaultPrevented, false);
  assert.equal(editor.keydown("d", null, { metaKey: true }).defaultPrevented, false);
  assert.equal(editor.state().x, before.x);
});

test("keyboard movement stops at the gray area boundary", () => {
  const editor = createEditor();
  editor.pointer("pointerdown", 480, 268);
  editor.pointer("pointerup", 480, 268);
  for (const [key, x, y, expectedX, expectedY] of [
    ["ArrowLeft", -2000, 268, -60, 240],
    ["d", 2000, 268, 252, 240],
    ["w", 480, -2000, 96, -160],
    ["ArrowDown", 480, 2000, 96, 644],
  ]) {
    editor.evaluate("rect = { x: 96, y: 240, w: 768, h: 56 }; draw()");
    editor.pointer("pointerdown", 480, 268);
    editor.pointer("pointermove", x, y);
    editor.pointer("pointerup", x, y);
    assert.equal(editor.state().x, expectedX);
    assert.equal(editor.state().y, expectedY);
    editor.keydown(key);
    assert.equal(editor.state().x, expectedX);
    assert.equal(editor.state().y, expectedY);
  }
});

test("keyboard movement respects the rotated box boundary", () => {
  const editor = createEditor();
  editor.evaluate("rect = { x: 300, y: 472, w: 400, h: 56 }; rotation = 90; selected = true; draw()");
  assert.equal(editor.keydown("ArrowDown").defaultPrevented, true);
  assert.equal(editor.state().y, 472);
  editor.keydown("w");
  assert.equal(editor.state().y, 471);
});

test("corner drag scales box and preview text by one factor", () => {
  const editor = createEditor();
  const before = editor.state();
  const cornerX = before.x + before.w;
  const cornerY = before.y + before.h;
  editor.pointer("pointerdown", cornerX, cornerY);
  editor.pointer("pointermove", cornerX + before.w * 0.1, cornerY + before.h * 0.1);
  const enlarged = editor.state();
  assert.ok(Math.abs(enlarged.w / before.w - 1.1) < 1e-10);
  assert.ok(Math.abs(enlarged.h / before.h - 1.1) < 1e-10);
  assert.ok(Math.abs(enlarged.fontSize / before.fontSize - 1.1) < 1e-10);
  assert.ok(Math.abs(parseFloat(editor.textDraws.at(-1).font) - 52.8) < 1e-10);
  editor.pointer("pointerup", cornerX + before.w * 0.1, cornerY + before.h * 0.1);

  const newCornerX = enlarged.x + enlarged.w;
  const newCornerY = enlarged.y + enlarged.h;
  editor.pointer("pointerdown", newCornerX, newCornerY);
  editor.pointer("pointermove", newCornerX - enlarged.w / 2, newCornerY - enlarged.h / 2);
  editor.pointer("pointerup", newCornerX - enlarged.w / 2, newCornerY - enlarged.h / 2);
  const reduced = editor.state();
  assert.ok(Math.abs(reduced.w / enlarged.w - 0.5) < 1e-10);
  assert.ok(Math.abs(reduced.h / enlarged.h - 0.5) < 1e-10);
  assert.ok(Math.abs(reduced.fontSize / enlarged.fontSize - 0.5) < 1e-10);
});

test("corner resize extends beyond the image and saves integer layer values", async () => {
  const editor = createEditor();
  const before = editor.state();
  editor.pointer("pointerdown", before.x + before.w, before.y + before.h);
  editor.pointer("pointermove", 2000, 2000);
  editor.pointer("pointerup", 2000, 2000);
  const resized = editor.state();
  assert.ok(resized.x + resized.w > 960);
  assert.ok(resized.x + resized.w <= 1020 + 1e-5);
  assert.ok(resized.y + resized.h <= 700 + 1e-5);
  assert.equal(editor.element("selectionBox").style.width, `${resized.w / 960 * 100}%`);
  assert.ok(Math.abs(resized.w / before.w - resized.h / before.h) < 1e-8);
  assert.ok(Math.abs(resized.w / before.w - resized.fontSize / before.fontSize) < 1e-8);
  assert.ok(resized.w > 0 && resized.h > 0);

  editor.setImageDataUrl("data:image/png;base64,AA==");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved.length, 1);
  assert.equal(editor.saved[0].w, String(Math.round(resized.w)));
  assert.equal(editor.saved[0].h, String(Math.round(resized.h)));
  assert.equal(editor.saved[0].fontsize, String(Math.round(resized.fontSize)));
  assert.equal(editor.saved[0].rotation, "0");
});

test("top-left corner resize stops at the gray area's edge", () => {
  const editor = createEditor();
  const before = editor.state();
  editor.pointer("pointerdown", before.x, before.y);
  editor.pointer("pointermove", before.x - 200, before.y - 300);
  editor.pointer("pointerup", before.x - 200, before.y - 300);
  const after = editor.state();
  assert.ok(after.x < 0);
  assert.ok(after.x >= -60 - 1e-5);
  assert.ok(after.y >= -160 - 1e-5);
  assert.ok(after.w > before.w);
  assert.ok(after.h > before.h);
});

test("existing template loads its box and font size for proportional resizing", async () => {
  const editor = createEditor({
    templates: {
      saved: {
        background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 400, h: 80, fontsize: 40 },
      },
    },
    user_templates: ["saved"],
    current: "saved",
  });
  await new Promise(setImmediate);
  const before = editor.state();
  assert.equal(before.w, 400);
  assert.equal(before.fontSize, 40);
  assert.ok(Math.abs(before.h - 40 * 7 / 6) < 1e-10);
  const x = before.x + before.w;
  const y = before.y + before.h;
  editor.pointer("pointerdown", x, y);
  editor.pointer("pointermove", x + 40, y + before.h * 0.1);
  editor.pointer("pointerup", x + 40, y + before.h * 0.1);
  const resized = editor.state();
  assert.ok(Math.abs(resized.x - before.x) < 1e-10);
  assert.ok(Math.abs(resized.y - before.y) < 1e-10);
  assert.ok(Math.abs(resized.w - 440) < 1e-10);
  assert.ok(Math.abs(resized.h - before.h * 1.1) < 1e-10);
  assert.ok(Math.abs(resized.fontSize - 44) < 1e-10);
});

test("pointer coordinates follow the displayed canvas size", () => {
  const editor = createEditor();
  const before = editor.state();
  editor.canvas.clientWidth = 480;
  editor.canvas.clientHeight = 270;
  editor.pointer("pointerdown", 75, 125);
  editor.pointer("pointermove", 90, 135);
  editor.pointer("pointerup", 90, 135);
  const moved = editor.state();
  assert.equal(moved.x, before.x + 30);
  assert.equal(moved.y, before.y + 20);
});

test("left and right handles change only width", () => {
  for (const side of ["left", "right"]) {
    const editor = createEditor();
    const before = editor.state();
    const x = side === "left" ? before.x : before.x + before.w;
    const y = before.y + before.h / 2;
    const change = side === "left" ? 30 : -30;
    editor.pointer("pointerdown", x, y);
    editor.pointer("pointermove", x + change, y);
    editor.pointer("pointerup", x + change, y);
    const after = editor.state();
    assert.ok(Math.abs(after.w - (before.w - 30)) < 1e-8);
    assert.ok(Math.abs(after.h - before.h) < 1e-8);
    assert.equal(after.fontSize, before.fontSize);
    assert.ok(Math.abs(after.x - (before.x + (side === "left" ? 30 : 0))) < 1e-8);
  }
});

test("side handles can resize past the left and right image edges", () => {
  for (const side of ["left", "right"]) {
    const editor = createEditor();
    const before = editor.state();
    const x = side === "left" ? before.x : before.x + before.w;
    const y = before.y + before.h / 2;
    const target = side === "left" ? -20 : 1000;
    editor.pointer("pointerdown", x, y);
    editor.pointer("pointermove", target, y);
    editor.pointer("pointerup", target, y);
    const after = editor.state();
    assert.ok(side === "left" ? after.x < 0 : after.x + after.w > 960);
  }
});

test("top and bottom edges have no resize handles", () => {
  const editor = createEditor();
  const box = editor.state();
  const x = box.x + box.w / 2;
  assert.equal(editor.evaluate(`handleAt({ x: ${x}, y: ${box.y} })`), "");
  assert.equal(editor.evaluate(`handleAt({ x: ${x}, y: ${box.y + box.h} })`), "");
});

test("vertical text moves the side handles to the top and bottom", () => {
  const editor = createEditor();
  editor.evaluate('orientation = "vertical"; rect = { x: 300, y: 160, w: 172.8, h: 240 }; draw()');
  const box = editor.state();
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  assert.equal(editor.element("selectionBox").classList.contains("vertical"), true);
  assert.equal(editor.evaluate(`handleAt({ x: ${centerX}, y: ${box.y} })`), "top");
  assert.equal(editor.evaluate(`handleAt({ x: ${centerX}, y: ${box.y + box.h} })`), "bottom");
  assert.equal(editor.evaluate(`handleAt({ x: ${box.x}, y: ${centerY} })`), "");
  assert.equal(editor.evaluate(`handleAt({ x: ${box.x + box.w}, y: ${centerY} })`), "");
  editor.pointer("pointermove", centerX, box.y);
  assert.equal(editor.canvasWrap.style.cursor, "ns-resize");

  editor.pointer("pointerdown", centerX, box.y);
  editor.pointer("pointermove", centerX, box.y + 20);
  editor.pointer("pointerup", centerX, box.y + 20);
  const after = editor.state();
  assert.equal(after.h, 220);
  assert.ok(after.w > box.w);
  assert.ok(Math.abs(after.y + after.h - box.y - box.h) < 1e-8);
  assert.equal(after.fontSize, box.fontSize);
});

test("vertical bottom handle resizes downward and wraps into fewer columns", () => {
  const editor = createEditor();
  editor.evaluate('orientation = "vertical"; rect = { x: 300, y: 160, w: 172.8, h: 240 }; draw()');
  const before = editor.state();
  const centerX = before.x + before.w / 2;
  editor.pointer("pointerdown", centerX, before.y + before.h);
  editor.pointer("pointermove", centerX, before.y + before.h + 110);
  editor.pointer("pointerup", centerX, before.y + before.h + 110);
  const after = editor.state();
  assert.equal(after.h, 350);
  assert.ok(after.w < before.w);
  assert.equal(after.y, before.y);
  assert.equal(after.fontSize, before.fontSize);
});

test("rotated vertical handles follow the box axis", () => {
  const editor = createEditor();
  editor.evaluate('orientation = "vertical"; rect = { x: 300, y: 160, w: 172.8, h: 240 }; rotation = 90; draw()');
  const before = editor.state();
  const centerX = before.x + before.w / 2;
  const centerY = before.y + before.h / 2;
  const topX = centerX + before.h / 2;
  assert.equal(editor.evaluate(`handleAt({ x: ${topX}, y: ${centerY} })`), "top");
  editor.pointer("pointermove", topX, centerY);
  assert.equal(editor.canvasWrap.style.cursor, "ew-resize");
  editor.pointer("pointerdown", topX, centerY);
  editor.pointer("pointermove", topX + 20, centerY);
  editor.pointer("pointerup", topX + 20, centerY);
  const after = editor.state();
  assert.ok(after.h > before.h);
  assert.equal(after.rotation, 90);
});

test("narrowing either side wraps text without changing glyph size", () => {
  for (const side of ["left", "right"]) {
    const editor = createEditor();
    const before = editor.state();
    const x = side === "left" ? before.x : before.x + before.w;
    const y = before.y + before.h / 2;
    const dx = side === "left" ? 630 : -630;
    editor.pointer("pointerdown", x, y);
    editor.pointer("pointermove", x + dx, y);
    editor.pointer("pointerup", x + dx, y);
    const after = editor.state();
    const lines = Array.from(editor.evaluate("textSize().lines"));
    assert.equal(after.fontSize, before.fontSize);
    assert.equal(after.w, before.w - 630);
    assert.ok(lines.length > 1);
    assert.ok(after.h > before.h);
    assert.ok(Math.abs(after.h - editor.evaluate("textSize().h")) < 1e-8);
    assert.ok(editor.textDraws.slice(-lines.length).every((draw) =>
      draw.maxWidth === undefined && parseFloat(draw.font) === before.fontSize
    ));
  }
});

test("a word that fits without its trailing space does not add a blank line", () => {
  const editor = createEditor();
  const lines = Array.from(editor.evaluate(
    "wrapText('Hello world', 130, (value) => value.length * 25)",
  ));
  assert.deepEqual(lines, ["Hello", "world"]);
});

test("all corners scale around their opposite corner", () => {
  for (const [name, sx, sy] of [
    ["nw", 0, 0], ["ne", 1, 0], ["se", 1, 1], ["sw", 0, 1],
  ]) {
    const editor = createEditor();
    const before = editor.state();
    const x = before.x + before.w * sx;
    const y = before.y + before.h * sy;
    const dx = (sx ? 1 : -1) * 12;
    const dy = (sy ? 1 : -1) * 12;
    editor.pointer("pointerdown", x, y);
    editor.pointer("pointermove", x + dx, y + dy);
    editor.pointer("pointerup", x + dx, y + dy);
    const after = editor.state();
    assert.ok(after.w > before.w, name);
    assert.ok(Math.abs(after.w / before.w - after.h / before.h) < 1e-8, name);
    assert.ok(Math.abs(after.w / before.w - after.fontSize / before.fontSize) < 1e-8, name);
    assert.ok(Math.abs(after.x + after.w * (1 - sx) - before.x - before.w * (1 - sx)) < 1e-8, name);
    assert.ok(Math.abs(after.y + after.h * (1 - sy) - before.y - before.h * (1 - sy)) < 1e-8, name);
  }
});

test("rotation handle supports clockwise and counterclockwise drags", async () => {
  const editor = createEditor();
  const before = editor.state();
  const centerX = before.x + before.w / 2;
  const centerY = before.y + before.h / 2;
  editor.pointer("pointerdown", centerX, centerY);
  editor.pointer("pointerup", centerX, centerY);
  assert.equal(editor.state().selected, true);
  const handleY = before.y + before.h + 28;
  editor.pointer("pointerdown", centerX, handleY);
  editor.pointer("pointermove", centerX - 50, centerY);
  editor.pointer("pointerup", centerX - 50, centerY);
  assert.ok(Math.abs(editor.state().rotation - 90) < 1e-8);

  editor.setImageDataUrl("data:image/png;base64,AA==", "turned");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved[0].rotation, "90");

  editor.pointer("pointerdown", centerX, centerY);
  editor.pointer("pointerup", centerX, centerY);
  const rotatedHandle = editor.evaluate("rotateVector(0, rect.h / 2 + 28)");
  editor.pointer("pointerdown", centerX + rotatedHandle.x, centerY + rotatedHandle.y);
  editor.pointer("pointermove", centerX, centerY + 50);
  editor.pointer("pointerup", centerX, centerY + 50);
  assert.ok(Math.abs(editor.state().rotation) < 1e-8);
});

test("axis guides appear only during near-horizontal or near-vertical rotation", () => {
  const editor = createEditor();
  const box = editor.state();
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  editor.pointer("pointerdown", centerX, centerY);
  editor.pointer("pointerup", centerX, centerY);
  editor.pointer("pointerdown", centerX, box.y + box.h + 28);
  editor.pointer("pointermove", centerX - 50, centerY);
  assert.equal(editor.element("alignmentGuide").style.display, "block");
  assert.equal(editor.element("alignmentGuide").style.height, "100%");
  editor.pointer("pointermove", centerX + 50, centerY - 50);
  assert.equal(editor.element("alignmentGuide").style.display, "none");
  editor.pointer("pointermove", centerX, centerY + 50);
  assert.equal(editor.element("alignmentGuide").style.display, "block");
  assert.equal(editor.element("alignmentGuide").style.width, "100%");
  editor.pointer("pointerup", centerX, centerY + 50);
  assert.equal(editor.element("alignmentGuide").style.display, "none");
});

test("rotation shows a signed angle beside the handle and hides it when done", () => {
  const editor = createEditor();
  const box = editor.state();
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  editor.pointer("pointerdown", centerX, centerY);
  editor.pointer("pointerup", centerX, centerY);
  editor.pointer("pointerdown", centerX, box.y + box.h + 28);
  const label = editor.element("rotationAngle");
  assert.equal(label.style.display, "block");
  assert.equal(label.textContent, "0°");
  const initialLeft = label.style.left;
  const initialTop = label.style.top;
  editor.pointer("pointermove", centerX + 50, centerY + 50);
  assert.ok(Math.abs(editor.state().rotation + 45) < 1e-8);
  assert.equal(label.textContent, "-45°");
  assert.notEqual(label.style.left, initialLeft);
  assert.notEqual(label.style.top, initialTop);
  editor.pointer("pointercancel", centerX + 50, centerY + 50);
  assert.equal(label.style.display, "none");
});

test("rotation does not let the frame exceed the gray area", () => {
  const editor = createEditor();
  editor.canvasWrap.bounds = { left: -60, top: 0, right: 1020, bottom: 540 };
  const box = editor.state();
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  editor.pointer("pointerdown", centerX, centerY);
  editor.pointer("pointerup", centerX, centerY);
  editor.pointer("pointerdown", centerX, box.y + box.h + 28);
  editor.pointer("pointermove", centerX - 50, centerY);
  assert.equal(editor.state().rotation, 0);
  assert.equal(editor.element("rotationAngle").textContent, "0°");
  editor.pointer("pointerup", centerX - 50, centerY);
});

test("rotation shifts a fitting frame fully inside the gray area", () => {
  const editor = createEditor();
  editor.canvasWrap.bounds = { left: -60, top: -60, right: 1020, bottom: 750 };
  const box = editor.state();
  const centerX = box.x + box.w / 2;
  const centerY = box.y + box.h / 2;
  editor.pointer("pointerdown", centerX, centerY);
  editor.pointer("pointerup", centerX, centerY);
  editor.pointer("pointerdown", centerX, box.y + box.h + 28);
  editor.pointer("pointermove", centerX - 50, centerY);
  const after = editor.state();
  assert.ok(Math.abs(after.rotation - 90) < 1e-8);
  assert.ok(Math.abs(after.y + after.h / 2 - after.w / 2 + 60) < 1e-8);
  assert.equal(editor.element("rotationAngle").textContent, "90°");
  editor.pointer("pointerup", centerX - 50, centerY);
});

test("new templates start with a usable text box", async () => {
  const editor = createEditor();
  editor.element("templateConfigBtn").dispatch("click");
  editor.element("drawerNameInput").value = "New";
  editor.element("drawerNameInput").dispatch("input");
  await editor.element("drawerConfirmBtn").dispatch("click");
  const box = editor.state();
  assert.equal(box.fontSize, 48);
  assert.ok(Math.abs(box.h - box.fontSize * 7 / 6) < 1e-8);
  assert.ok(box.w > 0);
  assert.equal(box.rotation, 0);
});

test("rotated side handle resizes along the box axis", () => {
  const editor = createEditor();
  editor.evaluate("rect = { x: 300, y: 200, w: 400, h: 56 }; rotation = 90; selected = true; draw()");
  const before = editor.state();
  const centerX = before.x + before.w / 2;
  const centerY = before.y + before.h / 2;
  const handleY = centerY + before.w / 2;
  editor.pointer("pointerdown", centerX, handleY);
  editor.pointer("pointermove", centerX, handleY + 20);
  editor.pointer("pointerup", centerX, handleY + 20);
  const after = editor.state();
  assert.ok(Math.abs(after.w - 420) < 1e-8);
  assert.ok(Math.abs(after.h - before.h) < 1e-8);
  assert.equal(after.fontSize, before.fontSize);
  assert.equal(after.rotation, 90);
});

test("corner cursors reflect diagonal and rotated resize directions", () => {
  const editor = createEditor();
  const box = editor.state();
  for (const [x, y, expected] of [
    [box.x, box.y, "nwse-resize"],
    [box.x + box.w, box.y, "nesw-resize"],
    [box.x + box.w, box.y + box.h, "nwse-resize"],
    [box.x, box.y + box.h, "nesw-resize"],
  ]) {
    editor.pointer("pointermove", x, y);
    assert.equal(editor.canvasWrap.style.cursor, expected);
  }

  editor.evaluate("rotation = 45");
  for (const [localX, localY, expected] of [
    [box.x, box.y, "ns-resize"],
    [box.x + box.w, box.y, "ew-resize"],
    [box.x + box.w, box.y + box.h, "ns-resize"],
    [box.x, box.y + box.h, "ew-resize"],
  ]) {
    const centerX = box.x + box.w / 2;
    const centerY = box.y + box.h / 2;
    const point = editor.evaluate(`rotateVector(${localX - centerX}, ${localY - centerY})`);
    editor.pointer("pointermove", centerX + point.x, centerY + point.y);
    assert.equal(editor.canvasWrap.style.cursor, expected);
  }
});

test("saved rotation is restored when an existing template loads", async () => {
  const editor = createEditor({
    templates: {
      saved: {
        background: "data:image/png;base64,AA==",
        layer: { x: 100, y: 100, w: 300, h: 80, fontsize: 40, rotation: -35 },
      },
    },
    user_templates: ["saved"],
    current: "saved",
  });
  await new Promise(setImmediate);
  assert.equal(editor.state().rotation, -35);
});

test("existing templates retain positions outside the image", async () => {
  const editor = createEditor({
    templates: {
      saved: {
        background: "data:image/png;base64,AA==",
        layer: { x: -80, y: -80, w: 300, h: 80, fontsize: 40 },
      },
    },
    user_templates: ["saved"],
    current: "saved",
  });
  await new Promise(setImmediate);
  assert.equal(editor.state().x, -80);
  assert.ok(editor.state().y < 0);
  assert.match(editor.element("selectionBox").style.left, /^-/);
});

test("position and size fields are absent from the toolbar", () => {
  assert.doesNotMatch(html, /id="[xywh]Input"/);
});
