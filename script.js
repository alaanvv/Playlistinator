const { AuthorizationCode } = require('simple-oauth2')
const { question } = require('readline-sync')
const express = require('express')
const axios = require('axios')
const opn = require('opn')
const fs = require('fs')

// ---

const YOUTUBE_CLIENT_SECRET = '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'
const YOUTUBE_CLIENT_ID = '784658982280-jpd6odl8f9pv6n7emos9hkbamqs9gjll.apps.googleusercontent.com'
const YOUTUBE_AUTH = { headers: {} }

const SPOTIFY_CLIENT_SECRET = 'eddfd3d364764953a1b1df1ec576d7fd'
const SPOTIFY_CLIENT_ID = 'b2cedf452851479bbe869e73f5aa2318'
const SPOTIFY_AUTH = { headers: {} }

let original_playlist = []
let songs_by_band = {}
let sort_method = 0
let playlist_name

// ---

function load_cache()      { return JSON.parse(fs.readFileSync('cache.json', 'utf8')) }
function save_cache(data)  { fs.writeFileSync('cache.json', JSON.stringify(data)) }
function validate_index(i) { return !isNaN(i) && 0 <= i < Object.values(songs_by_band).length }

async function get_youtube_auth() {
  const cache = load_cache()

  if (cache.auth && new Date() < new Date(cache.auth.expires_at) - (30 * 60e3))
    return YOUTUBE_AUTH.headers.Authorization = `Bearer ${cache.auth.auth_code}`

  const client = new AuthorizationCode({
    client: { id: YOUTUBE_CLIENT_ID, secret: YOUTUBE_CLIENT_SECRET },
    auth: { tokenHost: 'https://accounts.google.com', authorizePath: '/o/oauth2/auth', tokenPath: '/o/oauth2/token' }
  })

  opn(client.authorizeURL({ redirect_uri: 'http://localhost:8000', scope: 'https://www.googleapis.com/auth/youtube', state: 'random-state' }))

  return new Promise(resolve => { 
    const app = express()
    app.get('/', async (req, res) => { 
      const token = await client.getToken({ redirect_uri: 'http://localhost:8000', code: req.query.code })
      cache.auth = { auth_code: token.token.access_token, expires_at: token.token.expires_at }
      YOUTUBE_AUTH.headers.Authorization = `Bearer ${token.token.access_token}`
      save_cache(cache)
      res.send('You can close this')
      server.close()
      resolve()
    })
    const server = app.listen(8000)
  })
}

async function get_spotify_auth() {
  const client = new AuthorizationCode({
    client: { id: SPOTIFY_CLIENT_ID, secret: SPOTIFY_CLIENT_SECRET },
    auth: { tokenHost: 'https://accounts.spotify.com', authorizePath: '/authorize', tokenPath: '/api/token' }
  })

  opn(client.authorizeURL({ redirect_uri: 'http://localhost:8000/s', scope: 'user-read-private user-read-email playlist-modify-private playlist-modify-public', state: 'random-state' }))

  return new Promise(resolve => {
    const app = express()
    app.get('/s', async (req, res) => {
      const token = await client.getToken({ redirect_uri: 'http://localhost:8000/s', code: req.query.code })
      SPOTIFY_AUTH.headers.Authorization = `Bearer ${token.token.access_token}`
      res.send('You can close this')
      server.close()
      resolve()
    })
    const server = app.listen(8000)
  })
}

async function get_music_playlist() {
  const res = await axios.get('https://www.googleapis.com/youtube/v3/playlists?part=snippet&mine=true', YOUTUBE_AUTH)
  res.data.items.map((s, i) => { console.log(` ${i} - ${s.snippet.title}`) })
  const index = await question('\n Which playlist do you want to modify? \n > ')
  playlist_name = res.data.items[index].snippet.title
  return res.data.items[index].id
}

async function fetch_playlist_songs(playlist_id) {
  const songs = []
  const cache = load_cache()

  if (cache.backup && cache.backup.id == playlist_id && await question(`\n There's a backup from "${new Date(cache.backup.date).toLocaleString()}", use if you didn't add or remove songs since then (y/n)\n > `) == 'y')
    songs.push(...cache.backup.songs)
  else {
    let next_page_token
    do {
      const res = await axios.get(`https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&pageToken=${next_page_token || ''}&playlistId=${playlist_id}`, YOUTUBE_AUTH)
      console.log(res.data.items[0])

      songs.push(...res.data.items.map(s => ({
        owner: s.snippet.videoOwnerChannelTitle?.replace(/ - Topic|VEVO/g, ''),
        id: s.snippet.resourceId.videoId,
        title: s.snippet.title,
        playlist_item_id: s.id
      })))

      next_page_token = res.data.nextPageToken
    } while (next_page_token)

    cache.backup = { id: playlist_id, date: new Date(), songs }
    save_cache(cache)
  }

  original_playlist = [...songs]

  merge_backup = load_cache().merge || {}
  songs.forEach(video => {
    if (merge_backup[video.owner]) video.owner = merge_backup[video.owner]
    songs_by_band[video.owner] = songs_by_band[video.owner] || []
    songs_by_band[video.owner].push(video)
  })

  const sorting_mode = load_cache().sort

  if      (sorting_mode == 1) songs_by_band = Object.fromEntries(Object.entries(songs_by_band).sort((a, b) => b[1].length - a[1].length))
  else if (sorting_mode == 2) songs_by_band = Object.fromEntries(Object.entries(songs_by_band).sort((a, b) => a[1].length - b[1].length))
}

async function view_band_songs(index) {
  console.log('\033[2J')
  const [band, songs] = Object.entries(songs_by_band)[index]
  songs.map(s => console.log(` ${s.title}`))
  await question(`\n ${band}'s songs \n hit enter to go back `)
}

async function merge_band_songs(from, to) {
  const from_band = Object.entries(songs_by_band)[from]
  const to_band =   Object.entries(songs_by_band)[to]

  songs_by_band[to_band[0]].push(...from_band[1])
  delete songs_by_band[from_band[0]]

  cache = load_cache()
  if (!cache.merge) cache.merge = {}

  cache.merge[from_band[0]] = to_band[0]

  for (let [_from, _to] of Object.entries(cache.merge))
    if (_to == from_band[0]) cache.merge[_from] = to_band[0]

  save_cache(cache)
}

async function update_playlist(playlist_id) {
  const songs = []
  Object.values(songs_by_band).map(_songs => { songs.push(..._songs) })

  let id_to_stop
  if (sort_method == 1)
    id_to_stop = Object.values(songs_by_band).find(songs => songs.length == 1)[0].id
  else if (sort_method == 1)
    id_to_stop = Object.values(songs_by_band).unshift()

  console.log(`\n 0/${songs.length} updated`)
  for (let i in songs) {
    if (songs[i].id == original_playlist[i].id) continue
    if (songs[i].id == id_to_stop) break
    await axios.put('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet', {
      id: songs[i].playlist_item_id,
      snippet: { position: i, playlistId: playlist_id, resourceId: { kind: "youtube#video", videoId: songs[i].id } }
    }, YOUTUBE_AUTH)
    console.log(` ${Number(i) + 1}/${songs.length} updated`)

    const original_position = original_playlist.findIndex(song => song.id == songs[i].id)
    original_playlist = [...original_playlist.slice(0, i), songs[i], ...original_playlist.slice(i).filter(song => song.id != songs[i].id)]
  }
}

async function delete_band(index) {
  const [band, songs] = Object.entries(songs_by_band)[index]
  delete songs_by_band[band]
  console.log(`\n 0/${songs.length} deleted`)
  for (let i in songs) {
    await axios.delete(`https://www.googleapis.com/youtube/v3/playlistItems?id=${songs[i].playlist_item_id}`, YOUTUBE_AUTH)
    original_playlist = original_playlist.filter(song => song.id != songs[i].id)
    console.log(` ${Number(i) + 1}/${songs.length} deleted`)
  }
}

async function transfer_playlist() {
  const user_id =     (await axios.get(`https://api.spotify.com/v1/me`, SPOTIFY_AUTH)).data.id
  const playlist_id = (await axios.post(`https://api.spotify.com/v1/users/${user_id}/playlists`, { name: playlist_name }, SPOTIFY_AUTH)).data.id

  const queries = []
  for (let songs of Object.values(songs_by_band))
    for (let song of songs)
      queries.push(`${song.owner} ${song.title}`)

  let song_ids = []
  for (let q of queries)
      song_ids.push((await axios.get(`https://api.spotify.com/v1/search`, { params: { q, type: 'track', limit: 1 }, ...SPOTIFY_AUTH })).data.tracks.items[0].id)

  let cur = 0
  song_id_collections = []
  for (let song_id of song_ids) {
    if (song_id_collections[cur]?.length == 50) cur++
    song_id_collections[cur] = song_id_collections[cur] || []
    song_id_collections[cur].push(`spotify:track:${song_id}`)
  }

  for (let song_id_collection of song_id_collections)
    await axios.post(`https://api.spotify.com/v1/playlists/${playlist_id}/tracks`, { uris: song_id_collection }, SPOTIFY_AUTH)
}

async function prompt_user() {
  let should_alert = 0
  let finished = 0
  while (!finished) {
    console.log('\033[2J')

    const bands = Object.entries(songs_by_band)
    for (let i in bands) 
      console.log(` ${String(i).padStart(4, ' ')} - ${bands[i][0].padEnd(30, ' ').slice(0, 40)} ${`(${bands[i][1].length})`.padEnd(5, ' ')} [ ${bands[i][1][0].title.padEnd(80, ' ').slice(0, 80)} ]`)

    console.log(
      `\n ${`"v <band>"`.padEnd(20, ' ')} to view a band content` +
      `\n ${`"d <band>"`.padEnd(20, ' ')} to delete a band` + 
      `\n ${`"m <from> <to>"`.padEnd(20, ' ')} to merge bands` +
      `\n ${`"s1"`.padEnd(20, ' ')} to sort from band with most songs` +
      `\n ${`"s2"`.padEnd(20, ' ')} to sort from band with least songs` +
      `\n ${`"t"`.padEnd(20, ' ')} to transfer to Spotify` +
      `\n ${`"f"`.padEnd(20, ' ')} to finish` + 
      `${should_alert ? '\n > invalid command' : ''}`
    )

    should_alert = 0

    const action = await question(' > ')
    let [command, ...args] = action.trim().replaceAll('  ', ' ').split(' ')
    args = args.map(i => !isNaN(Number(i)) ? Number(i) : i)

    switch (command) {
      case 'v':
        if (validate_index(args[0])) view_band_songs(args[0])
        else should_alert = 1
        break

      case 'd':
        if (validate_index(args[0])) await delete_band(args[0])
        else should_alert = 1
        break

      case 'm':
        if (validate_index(args[0]) && validate_index(args[1])) merge_band_songs(args[0], args[1])
        else should_alert = 1
        break

      case 's1':
        songs_by_band = Object.fromEntries(Object.entries(songs_by_band).sort((a, b) => b[1].length - a[1].length))
        save_cache({ ...load_cache(), sort: 1 })
        sort_method = 1
        break

      case 's2':
        songs_by_band = Object.fromEntries(Object.entries(songs_by_band).sort((a, b) => a[1].length - b[1].length))
        save_cache({ ...load_cache(), sort: 2 })
        sort_method = 2
        break

      case 't':
        await get_spotify_auth()
        await transfer_playlist()
        break

      case 'f': 
        finished = 1
        break

      default:
        should_alert = 1
    }
  }
}

// ---

async function main() {
  if (!fs.existsSync('cache.json')) save_cache('{}')
  await get_youtube_auth()
  playlist_id = await get_music_playlist()
  await fetch_playlist_songs(playlist_id)

  await prompt_user()
  update_playlist(playlist_id)
}

main()
