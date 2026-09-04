import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase, usernameToEmail } from './supabase'

const FALLBACK_STATUS = [
  { key: 'new', label: '新規' },
  { key: 'in_progress', label: '作成中' },
  { key: 'done', label: '完了' }
]

const LONG_PRESS_MS = 260
const EDGE_SIZE = 70

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [items, setItems] = useState([])
  const [statuses, setStatuses] = useState(FALLBACK_STATUS)
  const [page, setPage] = useState(0)
  const [selected, setSelected] = useState(null)
  const [busy, setBusy] = useState(false)
  const [drag, setDrag] = useState(null)

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

      setPage(prev => Math.min(prev, data.length - 1))
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

  async function moveToStatus(item, nextStatus) {
    if (!item || item.status === nextStatus) return

    const { error } = await supabase
      .from('images')
      .update({
        status: nextStatus,
        updated_by: session.user.id,
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id)

    if (error) {
      alert(`状態変更に失敗しました: ${error.message}`)
      return
    }

    setItems(prev =>
      prev.map(x =>
        x.id === item.id ? { ...x, status: nextStatus } : x
      )
    )

    setSelected(prev =>
      prev?.id === item.id ? { ...prev, status: nextStatus } : prev
    )
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

    await supabase.storage.from('images').remove([item.storage_path])

    const { error } = await supabase
      .from('images')
      .delete()
      .eq('id', item.id)

    if (error) {
      alert(`削除に失敗しました: ${error.message}`)
      return
    }

    setSelected(null)
    loadItems()
  }

  function statusIndexFor(item) {
    return statuses.findIndex(s => s.key === item.status)
  }

  function initialTargetPageFor(item) {
    const origin = statusIndexFor(item)

    if (origin < 0) return 0
    if (origin === statuses.length - 1) return Math.max(0, origin - 1)
    return Math.min(statuses.length - 1, origin + 1)
  }

  function startDrag(item, x, y) {
    const originPage = statusIndexFor(item)
    const targetPage = initialTargetPageFor(item)

    setDrag({
      item,
      x,
      y,
      originPage,
      targetPage
    })
  }

  function updateDrag(x, y) {
    setDrag(prev => {
      if (!prev) return prev

      const lastPage = statuses.length - 1
      let targetPage = prev.targetPage

      if (prev.originPage <= 0) {
        targetPage = Math.min(1, lastPage)
      } else if (prev.originPage >= lastPage) {
        targetPage = Math.max(0, lastPage - 1)
      } else {
        const center = window.innerWidth / 2

        if (x < center - 30) {
          targetPage = prev.originPage - 1
        } else if (x > center + 30) {
          targetPage = prev.originPage + 1
        }
      }

      if (targetPage !== prev.targetPage) {
        setPage(targetPage)
      }

      if (
        prev.originPage < lastPage &&
        x > window.innerWidth - EDGE_SIZE
      ) {
        targetPage = prev.originPage + 1
        setPage(targetPage)
      }

      if (
        prev.originPage > 0 &&
        x < EDGE_SIZE
      ) {
        targetPage = prev.originPage - 1
        setPage(targetPage)
      }

      return {
        ...prev,
        x,
        y,
        targetPage
      }
    })
  }

  async function finishDrag() {
    if (!drag) return

    const { item, targetPage, originPage } = drag
    setDrag(null)

    if (targetPage === originPage) return

    const nextStatus = statuses[targetPage]?.key
    if (!nextStatus) return
    await moveToStatus(item, nextStatus)
    setPage(targetPage)
  }

  const grouped = useMemo(
    () => statuses.map(status => items.filter(item => item.status === status.key)),
    [items, statuses]
  )

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

        <button
          className="ghost"
          onClick={() => supabase.auth.signOut()}
        >
          ログアウト
        </button>
      </header>

      <nav className="page-tabs" style={{ gridTemplateColumns: `repeat(${Math.max(statuses.length, 1)}, minmax(92px, 1fr))` }}>
        {statuses.map((status, index) => (
          <button
            key={status.key}
            className={page === index ? 'page-tab active' : 'page-tab'}
            onClick={() => setPage(index)}
          >
            <span>{status.label}</span>
            <small>{grouped[index].length}</small>
          </button>
        ))}
      </nav>

      <label className="upload">
        <input
          type="file"
          accept="image/*"
          multiple
          onChange={e => upload(e.target.files)}
        />
        <span>＋ 画像を追加</span>
      </label>

      {busy && <div className="busy">処理中...</div>}

      <div className="pages-viewport">
        <div
          className="pages-track"
          style={{ transform: `translateX(-${page * 100}%)` }}
        >
          {statuses.map((statusInfo, pageIndex) => (
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

                <strong>{grouped[pageIndex].length}</strong>
              </div>

              {grouped[pageIndex].length === 0 ? (
                <div className="empty">
                  <span>
                    {pageIndex === 0
                      ? '画像を追加するとここに入ります'
                      : '画像をここへドラッグして移動'}
                  </span>
                </div>
              ) : (
                <div className="gallery">
                  {grouped[pageIndex].map(item => (
                    <ImageCard
                      key={item.id}
                      item={item}
                      onOpen={() => setSelected(item)}
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

      <div className="page-dots">
        {statuses.map((statusInfo, index) => (
          <button
            key={statusInfo.key}
            className={page === index ? 'dot active' : 'dot'}
            onClick={() => setPage(index)}
            aria-label={statusInfo.label}
          />
        ))}
      </div>

      {drag && (
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

          {drag.targetPage !== drag.originPage && (
            <div className="drag-hint">
              {statuses[drag.targetPage]?.label}へ移動
            </div>
          )}
        </>
      )}

      {selected && (
        <Viewer
          item={selected}
          setItem={setSelected}
          onClose={() => setSelected(null)}
          onSave={saveMeta}
          onDelete={remove}
          isAdmin={profile?.role === 'admin'}
          statuses={statuses}
        />
      )}
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
      if (Math.abs(dy) > 12) clearTimer()
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
  return (
    <div className="viewer">
      <button className="close" onClick={onClose}>×</button>

      <div className="viewer-image">
        <img
          src={item.public_url}
          alt={item.title || ''}
          draggable="false"
          onDragStart={e => e.preventDefault()}
        />
      </div>

      <div className="viewer-panel">
        <div className="viewer-status">
          {statuses.find(x => x.key === item.status)?.label || item.status}
        </div>

        <input
          value={item.title || ''}
          onChange={e =>
            setItem({ ...item, title: e.target.value })
          }
          onBlur={e =>
            onSave(item, { title: e.target.value })
          }
          placeholder="タイトル"
        />

        <textarea
          value={item.note || ''}
          onChange={e =>
            setItem({ ...item, note: e.target.value })
          }
          onBlur={e =>
            onSave(item, { note: e.target.value })
          }
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
