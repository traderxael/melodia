# Melodia

Reproductor de música **offline** para el celular. Importás tus canciones, armás tus playlists, y escuchás **sin internet y sin anuncios**. Es una PWA instalable: una vez que la guardás, funciona como una app nativa.

No descarga nada de servicios de streaming ni saltea protecciones de ningún tipo. Toda la música que suena sale de tu propio dispositivo.

## Melodia en tu celular

**App publicada:** <https://traderxael.github.io/melodia/>

1. Abrí ese link en el celu (Chrome en Android, Safari en iPhone).
2. Tocá **⋮ → Agregar a la pantalla de inicio** (o el botón **Instalar** dentro de Ajustes).
3. Abrila desde el ícono. Quedó instalada: funciona sin internet y sin barra de navegador.
4. Tocá el **+** para importar las canciones que ya tenés en el celu.

> Instalá y usala un par de veces entrando a Ajustes → **Pedir almacenamiento permanente**. Android e iOS pueden borrar los datos de sitios web que no usás, y sin ese permiso las canciones se pierden.

## Qué hace

- **Importar desde el celu**: MP3, M4A, AAC, FLAC, WAV, OGG, OPUS, AIFF.
- **Reproducir sin internet**: los archivos quedan guardados en el dispositivo (IndexedDB). Apagá los datos y sigue sonando.
- **Sin anuncios, sin cuentas, sin telemetría**: cero requests a terceros, cero scripts externos.
- **Playlists**: creá, renombrá, borrá y agrupá como quieras.
- **Lee etiquetas solo**: título, artista, álbum, año, género, número de pista y carátula, leyendo ID3v1, ID3v2.2/2.3/2.4, MP4/M4A, FLAC y Vorbis Comments.
- **Guardar en el celu**: exportá cualquier canción a tu carpeta Descargas (o a la carpeta que elijas, en escritorio).
- **Controles de bloqueo**: play/pausa, anterior/siguiente y volume desde la pantalla bloqueada.
- **Aleatorio, repetir todo, repetir una, cola editable, busqueda, favoritas, filtro por álbum/artista.**
- **Instalable**: se agrega a la pantalla de inicio y abre a pantalla completa, sin barra de navegador.

## Empezar

```bash
git clone https://github.com/traderxael/melodia.git
cd melodia
npm run dev
```

Abrí `http://localhost:5173`. No hay build, no hay dependencias: es HTML, CSS y JS nativo.

### Probarlo en el celular

1. Con la compu y el celu en el **mismo WiFi**, levantá el server.
2. Buscá la IP de tu compu (`ipconfig` / `ifconfig`) y abrí `http://192.168.x.x:5173` en el celu.
3. Tocá **Instalar** en Ajustes, o el menú del navegador ("Agregar a pantalla de inicio").

**Importante:** Android y iOS dan acceso a la cámara y al almacenamiento solo en `localhost` o en **HTTPS**. Para probarlo en el celu necesitás servirlo por HTTPS (GitHub Pages, Netlify, Cloudflare Pages) o usar `localhost` con un túnel.

### Publicar gratis

Como es estático, servilo donde quieras. En **GitHub Pages**: subí el repo,Settings → Pages → Deploy from a branch → `main` / root. Para que funcione desde un subdirectorio, todos los paths del proyecto son relativos, así que ya está listo.

## Tests

```bash
npm test              # todo: check estático + etiquetas + server + navegador
npm run check         # sintaxis, ids de HTML referenciados, SHELL del SW, manifest
npm run test:tags     # 36 pruebas del parser (ID3v1, ID3v2.3, ID3v2.4, MP4, FLAC, duración)
npm run test:server   # 28 pruebas: assets, manifest, PNG, path traversal
npm run test:browser  # 53 pruebas end-to-end en Chrome/Edge real vía DevTools Protocol
npm run icons         # regenera los PNG del ícono
```

`test:browser` levanta la app, importa canciones, reproduce, crea playlists, corta la red y verifica que **todo siga funcionando sin internet**. Se saltea solo si no encuentra Chrome o Edge, o si no tenés el módulo `ws`.

Para correrlo contra el sitio ya deployado en vez del servidor local:

```bash
MELODIA_URL=https://traderxael.github.io/melodia npm run test:browser
```

## Estructura

```
index.html              markup de la app
manifest.webmanifest    datos de instalación (PWA)
sw.js                   service worker: cachea el shell para uso offline
css/style.css           estilos (mobile-first, dark)
js/app.js               UI, navegación, eventos de teclado
js/player.js            motor de reproducción, cola, Media Session
js/db.js                capa de IndexedDB (tracks, playlists, ajustes)
js/library.js           importación, exportación y guardado de archivos
js/tags.js              lector de etiquetas y carátulas
tools/                  server de desarrollo, tests y generador de íconos
```

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `Espacio` | Reproducir / pausar |
| `/` | Buscar |
| `N` o `→` (Shift) | Siguiente |
| `P` | Anterior |
| `F` | Favorita |
| `S` | Aleatorio |
| `R` | Cambiar repetición |
| `Esc` | Cerrar la hoja abierta |

## De dónde sacar música (legal y gratis)

Melodia es un reproductor: no incluye música. Usá cosas que sean tuyas o de licencia libre.

- [Free Music Archive](https://freemusicarchive.org) — música libre con licencia clara.
- [Jamendo](https://jamendo.com) — artistas independientes, descarga gratis.
- [Internet Archive](https://archive.org/details/audio) — grabaciones de dominio público.
- [YouTube Audio Library](https://www.youtube.com/audiolibrary) — música sin atribución.
- Tus CDs, ripeados con Sound Juicer, VLC o Exact Audio Copyper.
- Tus compras en MP3, FLAC o M4A.

**No** uses Melodia para bajar canciones de Spotify, Apple Music o Deezer: eso requiere saltarse su DRM y es ilegal. Este proyecto no lo hace y no lo va a hacer.

## Límites que conviene saber

- **El almacenamiento del navegador no es un disco.** Android e iOS pueden borrar los datos de un sitio que no usás. Entrá a Ajustes y tocá **Pedir almacenamiento permanente** para que el navegador no lo toque. Harnesse un respaldo desde Ajustes → *Exportar biblioteca*.
- **FLAC y WAV ocupan mucho** (300 MB de FLAC ≈ 300 MB de espacio). Para el celu, MP3 o M4A a 128–192 kbps rinde mucho mejor.
- **No todos los navegadores reproducen todos los formatos.** Chrome y Safari en Android/iPhone reproducen MP3, M4A, AAC, OGG, OPUS, WAV y FLAC. AIFF y MKA a veces no. Si una canción no suena, convertila a MP3.
- El respaldo JSON guarda **etiquetas y playlists**, no el audio. Los archivos de audio se gestionan desde el celu.

## Licencia

MIT. Ver [LICENSE](LICENSE).
