import { regexps } from './namings';
/* import { parseUrl } from './utils';
import { normalizeUrl } from '../../shared/lib'; */

/*
 * This worker thread processes a chunk of URLs received from the main thread,
 * makes fetch requests to the specified URLs,
 * fetches CSS and JS resources used in these URLs,
 * identifies technologies used through regular expressions,
 * and incrementally writes the results to a file (one for each URL).
 */

declare var self: Worker;
export type RequestResult = [string, Array<string>];

const outDir = import.meta.dir + '/../out';

/*
 * The functions parseUrl and normalizeUrl are external.
 * I have included them here to provide further explanation of their usage.
 */

/* Returns a relative/external URL, based on the entered script/stylesheet source and URL origin */
function parseUrl(src: string, origin: string) {
 if (!src || src === '/') return;
 if (src.startsWith('//')) {
  return `https:${src}`;
 } else if (src.startsWith('/')) {
  return origin + src;
 } else if (src.startsWith('http')) {
  return src;
 }
 return `${origin}/${src}`;
}
/*
 * Removes http(s):// and replaces/removes special characters
 * Used for naming files
 */
function normalizeUrl(url: string) {
 return (
  url
   .replace(/http.*\/\//g, '')
   .replace('?', ',')
   .replace(/\//g, '_')
   // https://www.fileformat.info/info/unicode/char/0023/index.htm
   .replace(/#/g, '35')
   .toLowerCase()
 );
}

self.onmessage = async ({ data: urls }: MessageEvent) => {
 const requests: RequestResult[] = [];
 for (let i = 0; i < urls.length; i++) {
  const url = new URL(urls[i]);
  console.time('fetch');
  console.log(`| ${i + 1}/${urls.length} | ${url}`);

  try {
   const res = await fetch(url.href);
   const normalizedUrl = normalizeUrl(url.href);
   const dest = `${outDir}/${normalizedUrl}.txt`;
   const file = Bun.file(dest);
   /* Create an incremental file writer */
   const writer = file.writer();
   writer.start();

   writer.write(
    /* Instance a new dom transverser and transformer */
    await new HTMLRewriter()
     /* On match for a stylesheet fetch and write to file */
     .on("link[rel='stylesheet']", {
      async element(el) {
       try {
        const src = parseUrl(el.getAttribute('href')!, url.origin);
        if (!src) return;
        const cssRes = await fetch(src);
        writer.write(await cssRes.arrayBuffer());
       } catch (err) {
        console.error(`Failed to fetch css for ${url}:`, err);
       }
      },
     })
     /* Same here for scripts */
     .on('script', {
      async element(el) {
       try {
        const src = parseUrl(el.getAttribute('src')!, url.origin);
        if (!src) return;
        const jsRes = await fetch(src);
        writer.write(await jsRes.arrayBuffer());
       } catch (err) {
        console.error(`Failed to fetch js for ${url}:`, err);
       }
      },
     })
     /*
      * Same here
      * This happens in Svelte/SvelteKit, where they preload modules(scripts)
      */
     .on('link[rel="modulepreload"]', {
      async element(el) {
       try {
        const src = parseUrl(el.getAttribute('href')!, url.origin);
        if (!src) return;
        const jsRes = await fetch(src);
        writer.write(await jsRes.arrayBuffer());
       } catch (err) {
        console.error(`Failed to fetch js for ${url}:`, err);
       }
      },
     })
     /* Returns the just consumed response and writes it to the result file(the actual content of the page) */
     .transform(res)
     .arrayBuffer(),
   );
   /* Flush and close the file writer */
   writer.end();
   /* Get the closed file's content */
   const text = await file.text();
   /* Match each technology's regular expressions against the text and collect the matching keys
    * README: They're in an external file, I'm not going to bring them here because it's huge
    */
   const matchedExps = Object.keys(regexps)
    .map(key => {
     if (regexps[key as keyof typeof regexps].some((exp: RegExp) => exp.test(text))) return key;
     return;
    })
    /* Remove undefined returns */
    .filter(Boolean) as Array<string>;

   requests.push([url.toString(), matchedExps]);
   console.timeEnd('fetch');
  } catch (err) {
   console.error(`Failed to process ${url}:`, err);
  }
 }
 /* Post the result of all requests(an array of RequestResult => [URL, MATCHED_TECHNOLOGIES]) to the main thread */
 self.postMessage(requests);
};
