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

  function loadLazyVideo(video) {
    if (video.getAttribute("data-loaded") === "true") return;
    video.setAttribute("data-loaded", "true");

    video.querySelectorAll("source[data-src]").forEach(function (source) {
      source.src = source.getAttribute("data-src");
      source.removeAttribute("data-src");
    });

    video.load();
    if (video.hasAttribute("autoplay")) {
      var playAttempt = video.play();
      if (playAttempt && typeof playAttempt.catch === "function") {
        playAttempt.catch(function () {
          // Native controls remain available when autoplay is restricted.
        });
      }
    }
  }

  document.querySelectorAll("[data-lazy-video]").forEach(function (video) {
    if (!("IntersectionObserver" in window)) {
      loadLazyVideo(video);
      return;
    }

    var videoObserver = new IntersectionObserver(
      function (entries) {
        if (!entries.some(function (entry) { return entry.isIntersecting; })) {
          return;
        }
        videoObserver.disconnect();
        loadLazyVideo(video);
      },
      {
        rootMargin: "160px 0px",
        threshold: 0.01,
      },
    );

    videoObserver.observe(video);
  });

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
