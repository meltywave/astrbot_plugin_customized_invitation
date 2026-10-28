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

function createEditor(templateData = { templates: {} }) {
  const elements = new Map();
  const strokes = [];
  const textDraws = [];
  const context2d = {
    clearRect() {},
    drawImage() {},
    fillRect() {},
    setLineDash() {},
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    beginPath() {},
    arc() {},
    moveTo() {},
    lineTo() {},
    fill() {},
    stroke() {},
    measureText(text) {
      const size = parseFloat(this.font);
      return {
        width: size * Array.from(text).length * 0.6,
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
      };
    },
    strokeRect(x, y, w, h) {
      strokes.push({ x, y, w, h });
    },
    fillText(text, x, y, maxWidth) {
      textDraws.push({ text, font: this.font, maxWidth });
    },
  };

  function element(id) {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        id,
        value: id === "fontSizeInput" ? "48" : "",
        style: {},
        classList: { toggle() {} },
        children: [],
        addEventListener(type, callback) {
          listeners.set(type, callback);
        },
        dispatch(type, event = {}) {
          return listeners.get(type)?.(event);
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
  Object.assign(canvas, {
    width: 960,
    height: 540,
    clientWidth: 960,
    clientHeight: 540,
    clientLeft: 0,
    clientTop: 0,
    getContext: () => context2d,
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
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
    createElement: () => ({ value: "", textContent: "" }),
  };
  const saved = [];
  const window = {
    location: { search: "", hash: "" },
    innerWidth: 1400,
    innerHeight: 800,
    AstrBotPluginPage: {
      ready: async () => {},
      apiGet: async () => templateData,
      apiPost: async (_endpoint, payload) => {
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
    fetch: async () => ({ blob: async () => ({}) }),
    createImageBitmap: async () => ({ width: 960, height: 540 }),
  });
  vm.runInContext(script, environment);

  function pointer(type, x, y) {
    return canvas.dispatch(type, { clientX: x, clientY: y, pointerId: 1 });
  }

  function state() {
    const value = vm.runInContext("({ ...rect, fontSize, rotation, selected })", environment);
    return { ...value };
  }

  function evaluate(expression) {
    return vm.runInContext(expression, environment);
  }

  function setImageDataUrl(value) {
    environment.currentImageDataUrlForTest = value;
    vm.runInContext(
      "currentImageDataUrl = currentImageDataUrlForTest",
      environment,
    );
  }

  return { canvas, element, evaluate, pointer, saved, setImageDataUrl, state, strokes, textDraws };
}

test("outside drag leaves the text box in place", () => {
  const editor = createEditor();
  const before = editor.state();
  editor.pointer("pointerdown", 20, 20);
  editor.pointer("pointermove", 500, 400);
  editor.pointer("pointerup", 500, 400);
  assert.deepEqual(editor.state(), before);
  assert.equal(editor.canvas.capturedPointer, undefined);
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

test("resize stays within the image and saves integer layer values", async () => {
  const editor = createEditor();
  const before = editor.state();
  editor.pointer("pointerdown", before.x + before.w, before.y + before.h);
  editor.pointer("pointermove", 2000, 2000);
  editor.pointer("pointerup", 2000, 2000);
  const resized = editor.state();
  assert.ok(resized.x + resized.w <= 960);
  assert.ok(resized.y + resized.h <= 540);
  assert.ok(Math.abs(resized.w / before.w - resized.h / before.h) < 1e-8);
  assert.ok(Math.abs(resized.w / before.w - resized.fontSize / before.fontSize) < 1e-8);
  assert.ok(resized.w > 0 && resized.h > 0);

  editor.element("templateNameInput").value = "test";
  editor.setImageDataUrl("data:image/png;base64,AA==");
  await editor.element("saveBtn").dispatch("click");
  assert.equal(editor.saved.length, 1);
  assert.equal(editor.saved[0].w, String(Math.round(resized.w)));
  assert.equal(editor.saved[0].h, String(Math.round(resized.h)));
  assert.equal(editor.saved[0].fontsize, String(Math.round(resized.fontSize)));
  assert.equal(editor.saved[0].rotation, "0");
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

test("top and bottom edges have no resize handles", () => {
  const editor = createEditor();
  const box = editor.state();
  const x = box.x + box.w / 2;
  assert.equal(editor.evaluate(`handleAt({ x: ${x}, y: ${box.y} })`), "");
  assert.equal(editor.evaluate(`handleAt({ x: ${x}, y: ${box.y + box.h} })`), "");
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

  editor.element("templateNameInput").value = "turned";
  editor.setImageDataUrl("data:image/png;base64,AA==");
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

test("new images start with a snug text box", async () => {
  const editor = createEditor();
  editor.element("imageInput").files = [{}];
  await editor.element("imageInput").dispatch("change");
  const box = editor.state();
  assert.equal(box.fontSize, 45);
  assert.ok(Math.abs(box.h - box.fontSize * 7 / 6) < 1e-8);
  assert.ok(box.w < 960 / 2);
  assert.ok(box.w > 7 * box.fontSize);
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
    assert.equal(editor.canvas.style.cursor, expected);
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
    assert.equal(editor.canvas.style.cursor, expected);
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

test("position and size fields are absent from the sidebar", () => {
  assert.doesNotMatch(html, /位置与尺寸|id="[xywh]Input"/);
});
