// jsdom has no top-layer dialog implementation. Keep only its open state in
// unit tests; actual focus trapping, inertness and geometry are browser checks.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
}
