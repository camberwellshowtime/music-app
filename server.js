import index from './src/index.html'
import path from 'path'

const vocalsDir = path.resolve('../vocals')
const noVocalsDir = path.resolve('../no-vocals')
const lyricsDir = path.resolve('./src/lyrics')

function serve(port) {
  try {
    return Bun.serve({
      port,
      routes: {
        '/vocals/:file': req => new Response(Bun.file(path.join(vocalsDir, decodeURIComponent(req.params.file)))),
        '/no-vocals/:file': req => new Response(Bun.file(path.join(noVocalsDir, decodeURIComponent(req.params.file)))),
        '/lyrics/:file': async req => {
          const file = Bun.file(path.join(lyricsDir, decodeURIComponent(req.params.file)))
          if (!(await file.exists())) return new Response('Not found', { status: 404 })
          return new Response(file)
        },
        '/*': index,
      },
      development: {
        hmr: true,
        console: true,
      },
    })
  } catch (e) {
    if (e.code === 'EADDRINUSE') return serve(port + 1)
    throw e
  }
}

const server = serve(3000)

console.log(`Dev server running at ${server.url}`)
