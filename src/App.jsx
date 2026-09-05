import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, usernameToEmail } from './supabase'

const FALLBACK_STATUS = [
  { key: 'new', label: '新規' },
  { key: 'in_progress', label: '作成中' },
  { key: 'done', label: '完了' }
]

const LONG_PRESS_MS = 420
const EDGE_SIZE = 70
const TAG_PREFIX = '[[tags:'
const SET_PREFIX = '[[set:'

function parseStoredNote(value = '') {
  let rest = String(value || '')
  let tags = []
  let set = null

  const tagMatch = rest.match(/^\[\[tags:(.*?)\]\](?:\n|$)/)
  if (tagMatch) {
    tags = tagMatch[1]
      .split('|')
      .map(tag => tag.trim())
      .filter(Boolean)
    rest = rest.slice(tagMatch[0].length)
  }

  const setMatch = rest.match(/^\[\[set:([^|]+)\|([^|]*)\|(\d+)\]\](?:\n|$)/)
  if (setMatch) {
    let name = setMatch[2]
    try { name = decodeURIComponent(name) } catch {}
    set = {
      id: setMatch[1],
      name: name || '16枚セット',
      order: Number(setMatch[3]) || 1
    }
    rest = rest.slice(setMatch[0].length)
  }

  return { tags: [...new Set(tags)], set, note: rest }
}

function normalizeTags(value = '') {
  return [...new Set(
    String(value)
      .split(/[,、\n]/)
      .map(tag => tag.trim().replace(/^#/, ''))
      .filter(Boolean)
  )]
}

function buildStoredNote(tags, note = '', setInfo = null) {
  const cleanTags = normalizeTags(Array.isArray(tags) ? tags.join(',') : tags)
  const lines = []
  if (cleanTags.length) lines.push(`${TAG_PREFIX}${cleanTags.join('|')}]]`)
  if (setInfo?.id) {
    const safeName = encodeURIComponent(setInfo.name || '16枚セット')
    lines.push(`${SET_PREFIX}${setInfo.id}|${safeName}|${Number(setInfo.order) || 1}]]`)
  }
  if (note) lines.push(note)
  return lines.join('\n')
}

function itemSetInfo(item) {
  return parseStoredNote(item?.note).set
}

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [items, setItems] = useState([])
  const [statuses, setStatuses] = useState(FALLBACK_STATUS)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(null)
  const [search, setSearch] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [libraryMode, setLibraryMode] = useState('images')
  const [setSort, setSetSort] = useState('newest')
  const [selectedSet, setSelectedSet] = useState(null)
  const [showUserModal, setShowUserModal] = useState(false)
  const pageSwipeRef = useRef(null)
  const setInputRef = useRef(null)
  const tabsRef = useRef(null)

  const effectiveStatuses = useMemo(() => {
    const known = new Set(statuses.map(status => status.key))
    const orphanKeys = [...new Set(
      items
        .map(item => item.status)
        .filter(Boolean)
        .filter(key => !known.has(key))
    )]

    return [
      ...statuses,
      ...orphanKeys.map(key => ({
        key,
        label: `未分類 (${key})`,
        orphan: true
      }))
    ]
  }, [statuses, items])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
    })

    const { data: listener } = supabase.auth.onAuthStateChange(
      (_event, nextSession) => setSession(nextSession)
    )

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const nav = tabsRef.current
    if (!nav) return

    const activeButton = nav.querySelector(`[data-page-index="${page}"]`)
    if (!activeButton) return

    const targetLeft =
      activeButton.offsetLeft - (nav.clientWidth - activeButton.offsetWidth) / 2

    nav.scrollTo({
      left: Math.max(0, targetLeft),
      behavior: 'smooth'
    })
  }, [page, effectiveStatuses.length])

  useEffect(() => {
    setPage(prev => Math.max(0, Math.min(prev, Math.max(effectiveStatuses.length - 1, 0))))
  }, [effectiveStatuses.length])

  useEffect(() => {
    if (!session) return

    loadProfile()
    loadItems()
    loadStatuses()

    const imagesChannel = supabase
      .channel('images-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'images' },
        () => loadItems()
      )
      .subscribe()

    const settingsChannel = supabase
      .channel('status-settings-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'app_statuses' },
        () => loadStatuses()
      )
      .subscribe()

    return () => {
      supabase.removeChannel(imagesChannel)
      supabase.removeChannel(settingsChannel)
    }
  }, [session])

  async function loadProfile() {
    const { data } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single()

    setProfile(data)
  }

  async function loadItems() {
    const { data, error } = await supabase
      .from('images')
      .select('*')
      .order('created_at', { ascending: false })

    if (!error) setItems(data || [])
  }

  async function loadStatuses() {
    const { data, error } = await supabase
      .from('app_statuses')
      .select('key,label,position,is_active')
      .eq('is_active', true)
      .order('position', { ascending: true })

    if (!error && data?.length) {
      setStatuses(data)
    }
  }

  async function login(username, password) {
    setBusy(true)

    const { error } = await supabase.auth.signInWithPassword({
      email: usernameToEmail(username),
      password
    })

    setBusy(false)
    if (error) alert(error.message)
  }

  async function upload(files) {
    if (!files?.length) return

    setBusy(true)

    try {
      for (const file of Array.from(files)) {
        try {
          const ext = file.name.split('.').pop() || 'png'
          const path = `${crypto.randomUUID()}.${ext}`

          const { error: upErr } = await supabase.storage
            .from('images')
            .upload(path, file, {
              contentType: file.type || undefined,
              upsert: false
            })

          if (upErr) {
            alert(`アップロード失敗（${file.name}）: ${upErr.message}`)
            continue
          }

          const { data: publicData } = supabase.storage
            .from('images')
            .getPublicUrl(path)

          const { error: dbErr } = await supabase
            .from('images')
            .insert({
              title: file.name,
              note: '',
              status: statuses[0]?.key || 'new',
              storage_path: path,
              public_url: publicData.publicUrl,
              mime_type: file.type || '',
              original_name: file.name,
              created_by: session.user.id
            })

          if (dbErr) {
            alert(`データ保存失敗（${file.name}）: ${dbErr.message}`)
          }
        } catch (error) {
          alert(`アップロードエラー: ${error.message || error}`)
        }
      }
    } finally {
      setBusy(false)
      loadItems()
    }
  }

  async function uploadSet(files) {
    if (!files?.length) return

    const picked = Array.from(files).slice(0, 16)
    if (!picked.length) return

    const defaultName = `16枚セット ${new Date().toLocaleDateString('ja-JP')}`
    const setName = window.prompt('セット名を入力', defaultName)
    if (!setName) {
      if (setInputRef.current) setInputRef.current.value = ''
      return
    }

    if (picked.length !== 16) {
      const ok = window.confirm(`${picked.length}枚選択されています。16枚未満でもこのままセットにしますか？`)
      if (!ok) {
        if (setInputRef.current) setInputRef.current.value = ''
        return
      }
    }

    const setId = crypto.randomUUID()
    setBusy(true)

    try {
      for (let index = 0; index < picked.length; index += 1) {
        const file = picked[index]
        const ext = file.name.split('.').pop() || 'png'
        const path = `${crypto.randomUUID()}.${ext}`

        const { error: upErr } = await supabase.storage
          .from('images')
          .upload(path, file, {
            contentType: file.type || undefined,
            upsert: false
          })

        if (upErr) {
          alert(`アップロード失敗（${file.name}）: ${upErr.message}`)
          continue
        }

        const { data: publicData } = supabase.storage
          .from('images')
          .getPublicUrl(path)

        const note = buildStoredNote([], '', {
          id: setId,
          name: setName.trim(),
          order: index + 1
        })

        const { error: dbErr } = await supabase
          .from('images')
          .insert({
            title: file.name,
            note,
            status: statuses[0]?.key || 'new',
            storage_path: path,
            public_url: publicData.publicUrl,
            mime_type: file.type || '',
            original_name: file.name,
            created_by: session.user.id
          })

        if (dbErr) alert(`データ保存失敗（${file.name}）: ${dbErr.message}`)
      }
    } finally {
      setBusy(false)
      if (setInputRef.current) setInputRef.current.value = ''
      loadItems()
    }
  }

  async function moveEntityToStatus(item, nextStatus) {
    const setInfo = itemSetInfo(item)
    if (!setInfo?.id) return moveToStatus(item, nextStatus)

    const setItems = items.filter(x => itemSetInfo(x)?.id === setInfo.id)
    if (!setItems.length || setItems.every(x => x.status === nextStatus)) return

    const ids = setItems.map(x => x.id)
    const patch = {
      status: nextStatus,
      updated_by: session.user.id,
      updated_at: new Date().toISOString()
    }

    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { error } = await supabase.from('images').update(patch).in('id', ids)
        if (!error) {
          setItems(prev => prev.map(x => ids.includes(x.id) ? { ...x, status: nextStatus } : x))
          setSelectedSet(prev => prev?.id === setInfo.id ? { ...prev, status: nextStatus } : prev)
          return
        }
        lastError = error
      } catch (error) {
        lastError = error
      }
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 500))
    }

    alert(`セット移動に失敗しました: ${lastError?.message || lastError || '不明なエラー'}`)
  }

  async function moveToStatus(item, nextStatus) {
    if (!item || item.status === nextStatus) return

    const patch = {
      status: nextStatus,
      updated_by: session.user.id,
      updated_at: new Date().toISOString()
    }

    let lastError = null

    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { error } = await supabase
          .from('images')
          .update(patch)
          .eq('id', item.id)

        if (!error) {
          setItems(prev =>
            prev.map(x =>
              x.id === item.id ? { ...x, status: nextStatus } : x
            )
          )

          setSelected(prev =>
            prev?.id === item.id ? { ...prev, status: nextStatus } : prev
          )
          return
        }

        lastError = error
      } catch (error) {
        lastError = error
      }

      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 500))
      }
    }

    const message = lastError?.message || String(lastError || '不明なエラー')
    alert(`状態変更に失敗しました: ${message}\n通信が一時的に不安定な可能性があります。もう一度お試しください。`)
  }

  async function saveMeta(item, patch) {
    const { error } = await supabase
      .from('images')
      .update(patch)
      .eq('id', item.id)

    if (error) {
      alert(`保存に失敗しました: ${error.message}`)
      return
    }

    setItems(prev =>
      prev.map(x => x.id === item.id ? { ...x, ...patch } : x)
    )

    setSelected(prev =>
      prev?.id === item.id ? { ...prev, ...patch } : prev
    )
  }

  async function remove(item) {
    if (profile?.role !== 'admin') return
    if (!confirm('この画像を削除しますか？')) return

    const { error } = await supabase
      .from('images')
      .delete()
      .eq('id', item.id)

    if (error) {
      alert(`削除に失敗しました: ${error.message}`)
      return
    }

    const { error: storageError } = await supabase.storage
      .from('images')
      .remove([item.storage_path])

    if (storageError) {
      alert(`画像データの後片付けに失敗しました: ${storageError.message}`)
    }

    setSelected(null)
    loadItems()
  }

  async function removeSet(set) {
    if (profile?.role !== 'admin') return
    if (!set?.items?.length) return

    const ok = confirm(`「${set.name}」を16枚まとめて削除しますか？\nこの操作は元に戻せません。`)
    if (!ok) return

    const ids = set.items.map(item => item.id)
    const storagePaths = set.items.map(item => item.storage_path).filter(Boolean)

    const { error } = await supabase
      .from('images')
      .delete()
      .in('id', ids)

    if (error) {
      alert(`セット削除に失敗しました: ${error.message}`)
      return
    }

    if (storagePaths.length) {
      const { error: storageError } = await supabase.storage
        .from('images')
        .remove(storagePaths)

      if (storageError) {
        alert(`セット情報は削除しましたが、画像データの後片付けに失敗しました: ${storageError.message}`)
      }
    }

    setSelectedSet(null)
    setItems(prev => prev.filter(item => !ids.includes(item.id)))
  }

  async function renameSet(set, nextName) {
    const cleanName = String(nextName || '').trim()
    if (!set?.items?.length || !cleanName || cleanName === set.name) return true

    const updates = set.items.map(item => {
      const parsed = parseStoredNote(item.note)
      return {
        id: item.id,
        note: buildStoredNote(parsed.tags, parsed.note, {
          id: parsed.set?.id || set.id,
          name: cleanName,
          order: parsed.set?.order || 1
        })
      }
    })

    for (const update of updates) {
      const { error } = await supabase
        .from('images')
        .update({ note: update.note })
        .eq('id', update.id)

      if (error) {
        alert(`セット名の変更に失敗しました: ${error.message}`)
        return false
      }
    }

    setItems(prev =>
      prev.map(item => {
        const update = updates.find(x => x.id === item.id)
        return update ? { ...item, note: update.note } : item
      })
    )

    setSelectedSet(prev => prev?.id === set.id ? { ...prev, name: cleanName } : prev)
    return true
  }

  async function createUser(username, password) {
    if (profile?.role !== 'admin') return false

    const cleanUsername = String(username || '').trim()
    if (!cleanUsername) {
      alert('ユーザー名を入力してください')
      return false
    }

    if (String(password || '').length < 6) {
      alert('パスワードは6文字以上にしてください')
      return false
    }

    setBusy(true)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData?.session?.access_token

      if (!accessToken) {
        alert('ログイン情報を確認できませんでした。もう一度ログインしてください。')
        return false
      }

      const response = await fetch('/api/create-user', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({
          username: cleanUsername,
          email: usernameToEmail(cleanUsername),
          password
        })
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        alert(`ユーザー作成に失敗しました: ${result?.error || '不明なエラー'}`)
        return false
      }

      alert(`「${cleanUsername}」を作成しました`)
      setShowUserModal(false)
      return true
    } catch (error) {
      alert(`ユーザー作成に失敗しました: ${error?.message || error}`)
      return false
    } finally {
      setBusy(false)
    }
  }

  function statusIndexFor(item) {
    return effectiveStatuses.findIndex(s => s.key === item.status)
  }

  function initialTargetPageFor(item) {
    const origin = statusIndexFor(item)
    return origin >= 0 ? origin : 0
  }

  function startDrag(item, x, y) {
    const originPage = statusIndexFor(item)
    const targetPage = initialTargetPageFor(item)

    setDrag({
      item,
      x,
      y,
      originPage,
      targetPage,
      lastEdgeAt: 0
    })
  }

  function updateDrag(x, y) {
    setDrag(prev => {
      if (!prev) return prev

      const lastPage = effectiveStatuses.length - 1
      const edge = 84
      const now = Date.now()
      let targetPage = prev.targetPage
      let lastEdgeAt = prev.lastEdgeAt || 0

      // 上のステータスタブへ直接ドラッグした場合は、その項目を移動先にする
      const hoveredTab = document
        .elementFromPoint(x, y)
        ?.closest?.('[data-page-index]')
      const hoveredIndex = Number(hoveredTab?.dataset?.pageIndex)

      if (Number.isInteger(hoveredIndex) && hoveredIndex >= 0 && hoveredIndex <= lastPage) {
        targetPage = hoveredIndex
      } else if (now - lastEdgeAt > 420) {
        if (x < edge && targetPage > 0) {
          targetPage -= 1
          lastEdgeAt = now
        } else if (x > window.innerWidth - edge && targetPage < lastPage) {
          targetPage += 1
          lastEdgeAt = now
        }
      }

      if (targetPage !== prev.targetPage) {
        setPage(targetPage)
      }

      return {
        ...prev,
        x,
        y,
        targetPage,
        lastEdgeAt
      }
    })
  }

  async function finishDrag() {
    if (!drag) return

    const { item, targetPage, originPage } = drag
    setDrag(null)

    if (targetPage === originPage) return

    const nextStatus = effectiveStatuses[targetPage]?.key
    if (!nextStatus) return
    await moveEntityToStatus(item, nextStatus)
    setPage(targetPage)
  }

  function pageSwipeStart(e) {
    if (drag || e.touches.length !== 1) return

    const touch = e.touches[0]
    pageSwipeRef.current = {
      x: touch.clientX,
      y: touch.clientY
    }
  }

  function pageSwipeEnd(e) {
    const start = pageSwipeRef.current
    pageSwipeRef.current = null

    if (!start || drag) return

    const touch = e.changedTouches?.[0]
    if (!touch) return

    const dx = touch.clientX - start.x
    const dy = touch.clientY - start.y

    // 横方向のスワイプだけをページ移動として扱う
    if (Math.abs(dx) < 55 || Math.abs(dx) <= Math.abs(dy)) return

    if (dx < 0) {
      setPage(prev => Math.min(prev + 1, effectiveStatuses.length - 1))
    } else {
      setPage(prev => Math.max(prev - 1, 0))
    }
  }

  function pageSwipeCancel() {
    pageSwipeRef.current = null
  }

  const allTags = useMemo(() => {
    const tags = items.flatMap(item => parseStoredNote(item.note).tags)
    return [...new Set(tags)].sort((a, b) => a.localeCompare(b, 'ja'))
  }, [items])

  const filteredItems = useMemo(() => {
    const q = search.trim().toLowerCase()

    return items.filter(item => {
      const parsed = parseStoredNote(item.note)
      const matchesTag = !activeTag || parsed.tags.includes(activeTag)

      if (!matchesTag) return false
      if (!q) return true

      const haystack = [
        item.title,
        item.original_name,
        parsed.note,
        parsed.set?.name,
        ...parsed.tags
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()

      return haystack.includes(q)
    })
  }, [items, search, activeTag])

  const grouped = useMemo(
    () => effectiveStatuses.map(status => filteredItems.filter(item => item.status === status.key)),
    [filteredItems, effectiveStatuses]
  )

  const groupedEntries = useMemo(() => {
    return grouped.map(statusItems => {
      const result = []
      const seenSets = new Set()

      for (const item of statusItems) {
        const setInfo = itemSetInfo(item)

        if (libraryMode === 'images') {
          if (setInfo?.id) continue
          result.push({ type: 'item', item })
          continue
        }

        if (!setInfo?.id || seenSets.has(setInfo.id)) continue
        seenSets.add(setInfo.id)

        const setItems = statusItems
          .filter(x => itemSetInfo(x)?.id === setInfo.id)
          .sort((a, b) => (itemSetInfo(a)?.order || 0) - (itemSetInfo(b)?.order || 0))

        result.push({
          type: 'set',
          id: setInfo.id,
          name: setInfo.name,
          items: setItems,
          item: setItems[0],
          status: item.status
        })
      }

      return result
    })
  }, [grouped, libraryMode])

  const sortedSetEntries = useMemo(() => {
    const unique = []
    const seen = new Set()

    for (const entry of groupedEntries.flat()) {
      if (entry.type !== 'set' || seen.has(entry.id)) continue
      seen.add(entry.id)
      unique.push(entry)
    }

    const createdAt = entry => {
      const times = entry.items
        .map(item => new Date(item.created_at || 0).getTime())
        .filter(Number.isFinite)
      return times.length ? Math.max(...times) : 0
    }

    if (setSort === 'oldest') {
      return [...unique].sort((a, b) => createdAt(a) - createdAt(b))
    }

    if (setSort === 'name') {
      return [...unique].sort((a, b) => a.name.localeCompare(b.name, 'ja'))
    }

    return [...unique].sort((a, b) => createdAt(b) - createdAt(a))
  }, [groupedEntries, setSort])


  if (!session) {
    return <Login onLogin={login} busy={busy} />
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">One Life</div>
          <div className="tagline">One Life, Live Free.</div>
        </div>

        <div className="topbar-actions">
          {profile?.role === 'admin' && (
            <button
              type="button"
              className="user-add-button"
              onClick={() => setShowUserModal(true)}
            >
              ＋ユーザー
            </button>
          )}

          <button
            className="ghost"
            onClick={() => supabase.auth.signOut()}
          >
            ログアウト
          </button>
        </div>
      </header>

      <div className="library-switch" aria-label="保存場所">
        <button
          type="button"
          className={libraryMode === 'images' ? 'active' : ''}
          onClick={() => {
            setLibraryMode('images')
            setSearch('')
            setActiveTag('')
          }}
        >
          画像
        </button>
        <button
          type="button"
          className={libraryMode === 'sets' ? 'active' : ''}
          onClick={() => {
            setLibraryMode('sets')
            setSearch('')
            setActiveTag('')
          }}
        >
          16枚セット
        </button>
      </div>

      {libraryMode === 'images' && (
        <nav ref={tabsRef} className="page-tabs" >
          {effectiveStatuses.map((status, index) => (
            <button
              key={status.key}
              data-page-index={index}
              className={[
                'page-tab',
                page === index ? 'active' : '',
                drag?.targetPage === index && drag?.originPage !== index ? 'drag-target' : ''
              ].filter(Boolean).join(' ')}
              onClick={() => setPage(index)}
            >
              <span>{status.label}</span>
              <small>{groupedEntries[index].length}</small>
            </button>
          ))}
        </nav>
      )}

      <div className="search-tools">
        <div className="search-box">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={libraryMode === 'sets' ? "セット名を検索" : "タイトル・メモ・タグを検索"}
            aria-label="画像を検索"
          />
          {search && (
            <button
              type="button"
              className="search-clear"
              onClick={() => setSearch('')}
              aria-label="検索をクリア"
            >
              ×
            </button>
          )}
        </div>

        {allTags.length > 0 && (
          <div className="tag-filter" aria-label="タグで絞り込み">
            <button
              type="button"
              className={!activeTag ? 'tag-chip active' : 'tag-chip'}
              onClick={() => setActiveTag('')}
            >
              すべて
            </button>
            {allTags.map(tag => (
              <button
                type="button"
                key={tag}
                className={activeTag === tag ? 'tag-chip active' : 'tag-chip'}
                onClick={() => setActiveTag(prev => prev === tag ? '' : tag)}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="upload-actions single">
        {libraryMode === 'images' ? (
          <label className="upload">
            <input
              type="file"
              accept="image/*"
              multiple
              onChange={e => upload(e.target.files)}
            />
            <span>＋ 画像を追加</span>
          </label>
        ) : (
          <label className="upload set-upload">
            <input
              ref={setInputRef}
              type="file"
              accept="image/*"
              multiple
              onChange={e => uploadSet(e.target.files)}
            />
            <span>▦ 16枚セットを追加</span>
          </label>
        )}
      </div>

      {busy && <div className="busy">処理中...</div>}

      {libraryMode === 'sets' ? (
        <section className="status-page set-library-page">
          <div className="page-heading">
            <div>
              <h2>16枚セット</h2>
              <p>保存したセット一覧</p>
            </div>
            <strong>{sortedSetEntries.length}</strong>
          </div>

          <div className="set-sort">
            <span>並び替え</span>
            <select value={setSort} onChange={e => setSetSort(e.target.value)}>
              <option value="newest">新しい順</option>
              <option value="oldest">古い順</option>
              <option value="name">名前順</option>
            </select>
          </div>

          {sortedSetEntries.length === 0 ? (
            <div className="empty">
              <span>16枚セットを追加するとここに保存されます</span>
            </div>
          ) : (
            <div className="gallery">
              {sortedSetEntries.map(entry => (
                <SetCard
                  key={`set-${entry.id}`}
                  set={entry}
                  onOpen={() => setSelectedSet(entry)}
                  onDragStart={() => {}}
                  onDragMove={() => {}}
                  onDragEnd={() => {}}
                />
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          <div
            className="pages-viewport"
            onTouchStart={pageSwipeStart}
            onTouchEnd={pageSwipeEnd}
            onTouchCancel={pageSwipeCancel}
          >
            <div
              className="pages-track"
              style={{ transform: `translateX(-${page * 100}%)` }}
            >
              {effectiveStatuses.map((statusInfo, pageIndex) => (
                <section className="status-page" key={statusInfo.key}>
                  <div className="page-heading">
                    <div>
                      <h2>{statusInfo.label}</h2>
                      <p>
                        {statusInfo.key === 'new' && 'ここからスタート'}
                        {statusInfo.key === 'in_progress' && '作成している画像'}
                        {statusInfo.key === 'done' && '完成した画像'}
                        {!['new', 'in_progress', 'done'].includes(statusInfo.key) && '管理中の画像'}
                      </p>
                    </div>

                    <strong>{groupedEntries[pageIndex].length}</strong>
                  </div>

                  {groupedEntries[pageIndex].length === 0 ? (
                    <div className="empty">
                      <span>
                        {(search || activeTag)
                          ? '検索結果がありません'
                          : statusInfo.orphan
                            ? 'この項目は管理画面から削除されています。画像を別の項目へ移動してください'
                            : pageIndex === 0
                              ? '画像を追加するとここに入ります'
                              : '画像をここへドラッグして移動'}
                      </span>
                    </div>
                  ) : (
                    <div className="gallery">
                      {groupedEntries[pageIndex].map(entry => (
                        <ImageCard
                          key={entry.item.id}
                          item={entry.item}
                          onOpen={() => setSelected(entry.item)}
                          onDragStart={startDrag}
                          onDragMove={updateDrag}
                          onDragEnd={finishDrag}
                        />
                      ))}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </div>

          {effectiveStatuses.length <= 7 ? (
            <div className="page-dots">
              {effectiveStatuses.map((statusInfo, index) => (
                <button
                  key={statusInfo.key}
                  className={page === index ? 'dot active' : 'dot'}
                  onClick={() => setPage(index)}
                  aria-label={statusInfo.label}
                />
              ))}
            </div>
          ) : (
            <div className="page-position">
              {page + 1} / {effectiveStatuses.length}
            </div>
          )}
        </>
      )}

      {drag && libraryMode === 'images' && (
        <>
          <div
            className="drag-ghost"
            style={{
              left: drag.x,
              top: drag.y
            }}
          >
            <img
              src={drag.item.public_url}
              alt=""
              draggable="false"
            />
          </div>

          <div className="drag-status-bar" aria-hidden="true">
            <div className="drag-status-title">移動先</div>
            <strong>{effectiveStatuses[drag.targetPage]?.label || 'そのまま'}</strong>
            <small>左右端へ持っていくと項目切替・上の項目へ重ねても移動</small>
          </div>
        </>
      )}

      {showUserModal && profile?.role === 'admin' && (
        <UserCreateModal
          busy={busy}
          onClose={() => setShowUserModal(false)}
          onCreate={createUser}
        />
      )}

      {selectedSet && (
        <SetViewer
          set={selectedSet}
          onClose={() => setSelectedSet(null)}
          onOpenItem={item => { setSelectedSet(null); setSelected(item) }}
          onDelete={removeSet}
          onRename={renameSet}
          isAdmin={profile?.role === 'admin'}
        />
      )}

      {selected && (
        <Viewer
          item={selected}
          setItem={setSelected}
          onClose={() => setSelected(null)}
          onSave={saveMeta}
          onDelete={remove}
          isAdmin={profile?.role === 'admin'}
          statuses={effectiveStatuses}
        />
      )}
    </div>
  )
}

function UserCreateModal({ busy, onClose, onCreate }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  async function submit() {
    await onCreate(username, password)
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="user-modal" onClick={e => e.stopPropagation()}>
        <div className="user-modal-head">
          <div>
            <h3>ユーザー追加</h3>
            <p>この人専用のログインを作ります</p>
          </div>
          <button type="button" className="modal-close" onClick={onClose}>×</button>
        </div>

        <label>
          <span>ユーザー名</span>
          <input
            value={username}
            onChange={e => setUsername(e.target.value)}
            placeholder="例  yamada"
            autoCapitalize="none"
            autoCorrect="off"
          />
        </label>

        <label>
          <span>パスワード</span>
          <input
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="6文字以上"
            type="password"
          />
        </label>

        <button
          type="button"
          className="user-create-submit"
          disabled={busy}
          onClick={submit}
        >
          {busy ? '作成中...' : 'このユーザーを作成'}
        </button>

        <small className="user-modal-note">
          画像と16枚セットは、ほかのログインユーザーと共通で表示されます。
        </small>
      </div>
    </div>
  )
}

function Login({ onLogin, busy }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  return (
    <div className="login">
      <div className="login-card">
        <div className="brand big">One Life</div>
        <div className="tagline">One Life, Live Free.</div>

        <input
          placeholder="ユーザー名"
          value={username}
          onChange={e => setUsername(e.target.value)}
        />

        <input
          placeholder="パスワード"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
        />

        <button
          disabled={busy}
          onClick={() => onLogin(username, password)}
        >
          {busy ? 'ログイン中...' : 'ログイン'}
        </button>
      </div>
    </div>
  )
}

function SetCard({ set, onOpen, onDragStart, onDragMove, onDragEnd }) {
  const cover = set.items[0]
  const timerRef = useRef(null)
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })

  function clearTimer() {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }

  function pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const { clientX, clientY, pointerId } = e
    const target = e.currentTarget
    startRef.current = { x: clientX, y: clientY }
    movedRef.current = false
    draggingRef.current = false
    timerRef.current = setTimeout(() => {
      draggingRef.current = true
      onDragStart(cover, clientX, clientY)
      try { target.setPointerCapture(pointerId) } catch {}
    }, LONG_PRESS_MS)
  }

  function pointerMove(e) {
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) movedRef.current = true
    if (!draggingRef.current) {
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) clearTimer()
      return
    }
    e.preventDefault()
    onDragMove(e.clientX, e.clientY)
  }

  async function pointerUp() {
    clearTimer()
    if (draggingRef.current) {
      draggingRef.current = false
      await onDragEnd()
      return
    }
    if (!movedRef.current) onOpen()
  }

  function pointerCancel() {
    clearTimer()
    if (draggingRef.current) { draggingRef.current = false; onDragEnd() }
  }

  return (
    <article className="card set-card" onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel} onContextMenu={e => e.preventDefault()}>
      <div className="set-cover">
        {set.items.slice(0, 4).map(item => (
          <img key={item.id} src={item.public_url} alt="" loading="lazy" draggable="false" />
        ))}
        <span className="set-count">{set.items.length}枚</span>
      </div>
      <div className="card-meta">
        <strong>{set.name}</strong>
        <small>画像セット</small>
      </div>
    </article>
  )
}

function SetViewer({ set, onClose, onOpenItem, onDelete, onRename, isAdmin }) {
  const [sharing, setSharing] = useState(false)
  const [nameText, setNameText] = useState(set.name)
  const [renaming, setRenaming] = useState(false)
  const [shareReady, setShareReady] = useState(false)
  const [shareProgress, setShareProgress] = useState(0)
  const preparedFilesRef = useRef([])

  async function saveRename() {
    const clean = nameText.trim()
    if (!clean || clean === set.name) {
      setNameText(set.name)
      return
    }

    setRenaming(true)
    const ok = await onRename(set, clean)
    setRenaming(false)

    if (!ok) setNameText(set.name)
  }

  async function prepareShare() {
    setSharing(true)
    setShareReady(false)
    setShareProgress(0)
    preparedFilesRef.current = []

    try {
      const files = []

      for (let i = 0; i < set.items.length; i += 1) {
        const item = set.items[i]
        const response = await fetch(item.public_url, { cache: 'no-store' })
        if (!response.ok) throw new Error(`${i + 1}枚目の画像取得に失敗しました`)
        const blob = await response.blob()
        const ext = (item.original_name || '').split('.').pop() || 'png'
        files.push(
          new File(
            [blob],
            `${String(i + 1).padStart(2, '0')}.${ext}`,
            { type: blob.type || item.mime_type || 'image/png' }
          )
        )
        setShareProgress(i + 1)
      }

      if (!navigator.share || (navigator.canShare && !navigator.canShare({ files }))) {
        throw new Error('この端末では複数画像の共有に対応していません')
      }

      preparedFilesRef.current = files
      setShareReady(true)
    } catch (error) {
      preparedFilesRef.current = []
      setShareReady(false)
      alert(`共有準備に失敗しました: ${error?.message || error}`)
    } finally {
      setSharing(false)
    }
  }

  async function sharePrepared() {
    const files = preparedFilesRef.current
    if (!files.length) {
      setShareReady(false)
      return
    }

    try {
      // 共有APIは「ボタンを押した直後」に呼ぶ必要がある。
      // 準備済みファイルを使うことで、iPhone Safariの権限制限を回避しやすくする。
      const sharePromise = navigator.share({ files, title: set.name })
      setSharing(true)
      await sharePromise
    } catch (error) {
      if (error?.name !== 'AbortError') {
        alert(`共有に失敗しました: ${error?.message || error}`)
      }
    } finally {
      setSharing(false)
    }
  }

  return (
    <div className="viewer set-viewer">
      <button className="close" onClick={onClose}>×</button>
      <div className="set-viewer-panel">
        <div className="set-viewer-head">
          <div className="set-title-edit">
            <div className="set-viewer-kicker">16枚セット</div>
            <input
              className="set-name-input"
              value={nameText}
              onChange={e => setNameText(e.target.value)}
              onBlur={saveRename}
              onKeyDown={e => {
                if (e.key === 'Enter') e.currentTarget.blur()
              }}
              aria-label="セット名"
            />
            <p>{set.items.length}枚</p>
            {renaming && <small className="set-saving">保存中...</small>}
          </div>
        </div>

        <div className="share-steps">
          <button
            type="button"
            className={shareReady ? 'share-step done' : 'share-step'}
            disabled={sharing}
            onClick={prepareShare}
          >
            <span>1</span>
            <strong>{sharing ? `準備中 ${shareProgress}/${set.items.length}` : '共有の準備'}</strong>
          </button>

          <button
            type="button"
            className="share-step primary"
            disabled={sharing || !shareReady}
            onClick={sharePrepared}
          >
            <span>2</span>
            <strong>共有画面を開く</strong>
          </button>
        </div>

        <div className="set-grid">
          {set.items.map((item, index) => (
            <button key={item.id} className="set-grid-item" onClick={() => onOpenItem(item)}>
              <img src={item.public_url} alt="" loading="lazy" />
              <span>{index + 1}</span>
            </button>
          ))}
        </div>
        <p className="set-share-help">
          共有画面が開いたら「画像を保存」で16枚を写真へ保存できます。
        </p>

        {isAdmin && (
          <button
            type="button"
            className="danger"
            onClick={() => onDelete(set)}
          >
            この16枚セットを削除
          </button>
        )}
      </div>
    </div>
  )
}

function ImageCard({
  item,
  onOpen,
  onDragStart,
  onDragMove,
  onDragEnd
}) {
  const timerRef = useRef(null)
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const startRef = useRef({ x: 0, y: 0 })

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }

  function pointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return

    const clientX = e.clientX
    const clientY = e.clientY
    const pointerId = e.pointerId
    const target = e.currentTarget

    startRef.current = { x: clientX, y: clientY }
    movedRef.current = false
    draggingRef.current = false

    timerRef.current = setTimeout(() => {
      draggingRef.current = true
      onDragStart(item, clientX, clientY)

      try {
        target.setPointerCapture(pointerId)
      } catch {}
    }, LONG_PRESS_MS)
  }

  function pointerMove(e) {
    const dx = e.clientX - startRef.current.x
    const dy = e.clientY - startRef.current.y

    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
      movedRef.current = true
    }

    if (!draggingRef.current) {
      // 通常の画面スワイプを始めたら長押しドラッグ判定を解除
      if (Math.abs(dx) > 12 || Math.abs(dy) > 12) clearTimer()
      return
    }

    e.preventDefault()
    onDragMove(e.clientX, e.clientY)
  }

  async function pointerUp() {
    clearTimer()

    if (draggingRef.current) {
      draggingRef.current = false
      await onDragEnd()
      return
    }

    if (!movedRef.current) onOpen()
  }

  function pointerCancel() {
    clearTimer()

    if (draggingRef.current) {
      draggingRef.current = false
      onDragEnd()
    }
  }

  return (
    <article
      className="card"
      onPointerDown={pointerDown}
      onPointerMove={pointerMove}
      onPointerUp={pointerUp}
      onPointerCancel={pointerCancel}
      onContextMenu={e => e.preventDefault()}
    >
      <img
        src={item.public_url}
        alt={item.title || ''}
        loading="lazy"
        draggable="false"
        onDragStart={e => e.preventDefault()}
      />

      <div className="card-meta">
        <strong>{item.title || item.original_name}</strong>
        {parseStoredNote(item.note).tags.length > 0 && (
          <div className="card-tags">
            {parseStoredNote(item.note).tags.slice(0, 3).map(tag => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}
        <small>{item.mime_type || 'image'}</small>
      </div>
    </article>
  )
}

function Viewer({
  item,
  setItem,
  onClose,
  onSave,
  onDelete,
  isAdmin,
  statuses
}) {
  const parsed = parseStoredNote(item.note)
  const [title, setTitle] = useState(item.title || '')
  const [noteText, setNoteText] = useState(parsed.note)
  const [tagText, setTagText] = useState(parsed.tags.join(', '))

  function saveTitle() {
    if (title === (item.title || '')) return
    onSave(item, { title })
    setItem({ ...item, title })
  }

  function saveDetails() {
    const nextTags = normalizeTags(tagText)
    const nextNote = buildStoredNote(nextTags, noteText, parsed.set)

    if (nextNote === (item.note || '')) return

    onSave(item, { note: nextNote })
    setItem({ ...item, note: nextNote })
  }

  return (
    <div className="viewer">
      <button className="close" onClick={onClose}>×</button>

      <div className="viewer-image">
        <img
          src={item.public_url}
          alt={title || ''}
          draggable="false"
          onDragStart={e => e.preventDefault()}
        />
      </div>

      <div className="viewer-panel">
        <div className="viewer-status">
          {statuses.find(x => x.key === item.status)?.label || item.status}
        </div>

        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          onBlur={saveTitle}
          placeholder="タイトル"
        />

        <div className="tag-editor">
          <label>タグ</label>
          <input
            value={tagText}
            onChange={e => setTagText(e.target.value)}
            onBlur={saveDetails}
            placeholder="例：LINEスタンプ, Adobe Stock, ロゴ"
          />
          <small>カンマで区切って複数追加できます</small>
        </div>

        {normalizeTags(tagText).length > 0 && (
          <div className="viewer-tags">
            {normalizeTags(tagText).map(tag => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        )}

        <textarea
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
          onBlur={saveDetails}
          placeholder="メモ"
        />

        <div className="fileinfo">
          {item.original_name} / {item.mime_type || 'unknown'}
        </div>

        {isAdmin && (
          <button
            className="danger"
            onClick={() => onDelete(item)}
          >
            削除
          </button>
        )}
      </div>
    </div>
  )
}
