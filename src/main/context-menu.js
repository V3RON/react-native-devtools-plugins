// Native context menus for the frontend's showContextMenuAtPoint host call.
// Consumes Chrome's ContextMenuDescriptor[] shape and dispatches the
// selection back through the dispatch channel
// (contextMenuItemSelected / contextMenuCleared).
const { Menu } = require("electron");
const { dispatchToFrontend } = require("./dispatch");

// Pure mapping: Chrome ContextMenuDescriptor -> Electron MenuItemOptions.
// Exported for unit testing without an Electron runtime.
const toTemplate = (items) =>
  (items || []).map((item) => {
    if (item.type === "separator") {
      return { type: "separator" };
    }
    const template = {
      type: item.type === "checkbox" ? "checkbox" : "normal",
      label: item.label,
      enabled: item.enabled !== false,
      click: () => dispatchToFrontend("contextMenuItemSelected", [item.id]),
    };
    if (template.type === "checkbox") {
      template.checked = !!item.checked;
    }
    if (item.type === "subMenu") {
      template.submenu = toTemplate(item.subItems); // Electron accepts raw templates
    }
    return template;
  });

// x/y arrive in frontend window content coordinates; popup() expects
// screen coordinates, so offset by the window's content bounds.
const showContextMenu = (win, { x, y, items }) => {
  if (!win || win.isDestroyed()) {
    return;
  }
  const menu = Menu.buildFromTemplate(toTemplate(items));
  menu.once("menu-will-close", () => dispatchToFrontend("contextMenuCleared"));
  const bounds = win.getContentBounds();
  menu.popup({ window: win, x: bounds.x + x, y: bounds.y + y });
};

module.exports = { toTemplate, showContextMenu };
