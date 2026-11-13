// Moving between the home page and maps without reloading the page, so the connection to illuminate (and what's on screen)
// carries over. Links inside the app are plain <a href>s; a click on one is turned into a navigation here.
import { useEffect, useState } from 'react';

export function navigate(url: string) {
  if (url === `${location.pathname}${location.search}`) return;
  history.pushState(null, '', url);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** The current path, kept up to date through back/forward and `navigate`, with in-app link clicks taken over. */
export function usePath(): string {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement) || a.target || a.origin !== location.origin) return;
      e.preventDefault();
      navigate(`${a.pathname}${a.search}`);
    };
    window.addEventListener('popstate', onPop);
    document.addEventListener('click', onClick);
    return () => {
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick);
    };
  }, []);
  return path;
}
