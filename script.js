// script.js
// Smooth section "page" transitions and navigation highlighting
document.addEventListener('DOMContentLoaded', function(){
  const menuBtn = document.getElementById('menu-btn');
  const nav = document.getElementById('nav');
  const navLinks = Array.from(document.querySelectorAll('.nav-link'));
  const sections = Array.from(document.querySelectorAll('.section'));
  const yearEl = document.getElementById('year');

  // Set year
  if(yearEl) yearEl.textContent = new Date().getFullYear();

  // Mobile menu toggle
  menuBtn && menuBtn.addEventListener('click', () => {
    nav.classList.toggle('open');
  });

  // Close mobile menu when clicking a nav link
  navLinks.forEach(a => a.addEventListener('click', () => {
    if(nav.classList.contains('open')) nav.classList.remove('open');
  }));

  // IntersectionObserver to add in-view class for nice transitions
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const el = entry.target;
      if(entry.isIntersecting){
        el.classList.add('in-view');
        // update active nav link
        const id = el.id;
        setActiveNav(id);
        history.replaceState(null, '', '#' + id); // keep URL in sync (hash)
      } else {
        // Optional: remove when scrolled out of view
        // el.classList.remove('in-view');
      }
    });
  }, { threshold: 0.45 });

  sections.forEach(s => io.observe(s));

  function setActiveNav(id){
    navLinks.forEach(a => {
      const href = a.getAttribute('href').replace('#','');
      if(href === id) a.classList.add('active'); else a.classList.remove('active');
    });
  }

  // On load, if there's a hash, scroll to it smoothly
  if(location.hash){
    const target = document.querySelector(location.hash);
    if(target){
      // Wait a tick so that IntersectionObserver and styles apply
      setTimeout(()=> target.scrollIntoView({behavior:'smooth', block:'start'}), 120);
    }
  }

  // Optional: update active link when user presses keyboard to navigate
  window.addEventListener('hashchange', () => {
    const id = location.hash.replace('#','') || 'home';
    setActiveNav(id);
  });

  // Enhance "link-like" behavior for internal anchors (smooth scroll)
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      // allow normal behavior for empty hash
      const href = a.getAttribute('href');
      if(href === '#') return;
      const target = document.querySelector(href);
      if(target){
        e.preventDefault();
        target.scrollIntoView({behavior:'smooth', block:'start'});
        // close mobile menu if open
        if(nav.classList.contains('open')) nav.classList.remove('open');
      }
    });
  });

});
