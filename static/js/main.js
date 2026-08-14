(function () {
  "use strict";

  function setActiveSection(id) {
    document.querySelectorAll("[data-nav-link]").forEach(function (link) {
      var active = link.getAttribute("href") === "#" + id;
      link.classList.toggle("is-active", active);

      if (active) {
        link.setAttribute("aria-current", "location");
      } else {
        link.removeAttribute("aria-current");
      }
    });
  }

  var sections = Array.prototype.slice.call(
    document.querySelectorAll("[data-section]"),
  );

  if ("IntersectionObserver" in window && sections.length > 0) {
    var sectionObserver = new IntersectionObserver(
      function (entries) {
        var visible = entries
          .filter(function (entry) {
            return entry.isIntersecting;
          })
          .sort(function (a, b) {
            return b.intersectionRatio - a.intersectionRatio;
          });

        if (visible[0] && visible[0].target.id) {
          setActiveSection(visible[0].target.id);
        }
      },
      {
        rootMargin: "-18% 0px -64% 0px",
        threshold: [0.08, 0.25, 0.55],
      },
    );

    sections.forEach(function (section) {
      sectionObserver.observe(section);
    });
  }

  document.querySelectorAll("[data-copy-target]").forEach(function (button) {
    button.addEventListener("click", async function () {
      var targetId = button.getAttribute("data-copy-target");
      var target = targetId ? document.getElementById(targetId) : null;

      if (!target) {
        return;
      }

      try {
        await navigator.clipboard.writeText(target.textContent || "");
        var originalText = button.textContent;
        button.textContent = "Copied";
        window.setTimeout(function () {
          button.textContent = originalText;
        }, 1800);
      } catch (error) {
        button.textContent = "Select and copy";
      }
    });
  });
})();
