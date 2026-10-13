// Elige el idioma: ?lang=es|en en la dirección → si no, el del navegador → si no, español.
(function () {
  var html = document.documentElement;
  function poner(lang) {
    html.setAttribute("data-lang", lang);
    html.setAttribute("lang", lang);
    var botones = document.querySelectorAll("nav.idioma button");
    for (var i = 0; i < botones.length; i++) {
      botones[i].setAttribute("aria-pressed", botones[i].getAttribute("data-lang") === lang ? "true" : "false");
    }
    var t = html.getAttribute("data-title-" + lang);
    if (t) document.title = t;
  }
  var pedido = null;
  try { pedido = new URLSearchParams(location.search).get("lang"); } catch (e) {}
  var inicial = pedido === "en" || pedido === "es" ? pedido
    : ((navigator.language || "es").toLowerCase().indexOf("es") === 0 ? "es" : "en");
  poner(inicial);
  document.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("nav.idioma button");
    if (!b) return;
    var lang = b.getAttribute("data-lang");
    poner(lang);
    try { var u = new URL(location.href); u.searchParams.set("lang", lang); history.replaceState(null, "", u); } catch (e2) {}
  });
})();
