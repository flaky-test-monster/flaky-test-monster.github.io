// Slideshows on the about page: previous and next buttons and a counter for a row of photos
// that scroll-snaps. The row works without this module too (scroll, swipe, arrow keys).

/**
 * Wires up one slideshow.
 * @param {HTMLElement} show the .slideshow element
 */
function initSlideshow(show) {
  const track = show.querySelector('.slides');
  const controls = show.querySelector('.slide-controls');
  const slides = track ? [...track.querySelectorAll('.slide')] : [];
  if (slides.length < 2 || !controls) return;
  const prev = controls.querySelector('.slide-prev');
  const next = controls.querySelector('.slide-next');
  const count = controls.querySelector('.slide-count');

  /** Scroll position at which a slide is in view. */
  const leftOf = (slide) => slide.offsetLeft - slides[0].offsetLeft;
  // Read from the scroll position, so swiping and the buttons stay in step.
  const current = () => {
    let best = 0;
    slides.forEach((slide, i) => {
      if (Math.abs(leftOf(slide) - track.scrollLeft) < Math.abs(leftOf(slides[best]) - track.scrollLeft)) best = i;
    });
    return best;
  };
  const goTo = (index) => {
    track.scrollTo({ left: leftOf(slides[Math.max(0, Math.min(slides.length - 1, index))]) });
  };
  const update = () => {
    const index = current();
    count.textContent = `${index + 1} / ${slides.length}`;
    prev.disabled = index === 0;
    next.disabled = index === slides.length - 1;
  };

  let frame = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }, { passive: true });
  prev.addEventListener('click', () => goTo(current() - 1));
  next.addEventListener('click', () => goTo(current() + 1));
  // One photo per key press, rather than the browser's small scroll step.
  track.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    goTo(current() + (event.key === 'ArrowRight' ? 1 : -1));
  });

  controls.hidden = false;
  show.classList.add('has-controls');
  update();
}

document.querySelectorAll('.slideshow').forEach(initSlideshow);
