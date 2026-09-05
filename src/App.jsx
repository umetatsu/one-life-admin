import React, { useEffect, useState } from 'react'
import { supabase, usernameToEmail } from './supabase'

const FIELD_TYPES = [
  { value: 'text', label: 'テキスト' },
  { value: 'select', label: '選択式' },
  { value: 'date', label: '日付' },
  { value: 'checkbox', label: 'チェック' },
  { value: 'user', label: '担当者' }
]

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [statuses, setStatuses] = useState([])
  const [fields, setFields] = useState([])
  const [tab, setTab] = useState('statuses')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession)
    })
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      setProfile(null)
      return
    }
    loadProfile()
  }, [session])

  useEffect(() => {
    if (profile?.role === 'admin') {
      loadAll()
    }
  }, [profile])

  async function loadProfile() {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', session.user.id)
      .single()

    if (error) {
      alert(`プロフィール取得失敗: ${error.message}`)
      return
    }
    setProfile(data)
  }

  async function loadAll() {
    const [{ data: s, error: se }, { data: f, error: fe }] = await Promise.all([
      supabase.from('app_statuses').select('*').order('position'),
      supabase.from('app_fields').select('*').order('position')
    ])

    if (se) alert(`ステータス取得失敗: ${se.message}`)
    if (fe) alert(`管理項目取得失敗: ${fe.message}`)

    setStatuses(s || [])
    setFields(f || [])
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

  async function createUser() {
    if (profile?.role !== 'admin') return

    const username = prompt('追加するユーザー名')
    if (!username?.trim()) return

    const password = prompt('パスワード（6文字以上）')
    if (!password) return

    if (password.length < 6) {
      alert('パスワードは6文字以上にしてください。')
      return
    }

    setBusy(true)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const accessToken = sessionData?.session?.access_token

      if (!accessToken) {
        alert('ログイン情報を確認できませんでした。もう一度ログインしてください。')
        return
      }

      const cleanUsername = username.trim()

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
        return
      }

      alert(`「${cleanUsername}」を作成しました`)
    } catch (error) {
      alert(`ユーザー作成に失敗しました: ${error?.message || error}`)
    } finally {
      setBusy(false)
    }
  }

  async function addStatus() {
    const label = prompt('追加するステータス名')
    if (!label?.trim()) return
    const key = `status_${Date.now()}`

    const { error } = await supabase.from('app_statuses').insert({
      key,
      label: label.trim(),
      position: statuses.length
    })

    if (error) return alert(error.message)
    loadAll()
  }

  async function renameStatus(item) {
    const label = prompt('新しい名前', item.label)
    if (!label?.trim() || label.trim() === item.label) return

    const { error } = await supabase
      .from('app_statuses')
      .update({ label: label.trim(), updated_at: new Date().toISOString() })
      .eq('id', item.id)

    if (error) return alert(error.message)
    loadAll()
  }

  async function deleteStatus(item) {
    if (['new', 'in_progress', 'done'].includes(item.key)) {
      return alert('新規・作成中・完了は基本ステータスなので削除できません。')
    }
    if (!confirm(`「${item.label}」を削除しますか？`)) return

    const { error } = await supabase
      .from('app_statuses')
      .delete()
      .eq('id', item.id)

    if (error) return alert(error.message)
    loadAll()
  }

  async function moveStatus(item, direction) {
    const index = statuses.findIndex(x => x.id === item.id)
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= statuses.length) return

    const target = statuses[targetIndex]
    await Promise.all([
      supabase.from('app_statuses').update({ position: target.position }).eq('id', item.id),
      supabase.from('app_statuses').update({ position: item.position }).eq('id', target.id)
    ])
    loadAll()
  }

  async function addField() {
    const label = prompt('追加する管理項目名')
    if (!label?.trim()) return

    const type = prompt(
      '種類を入力: text / select / date / checkbox / user',
      'text'
    )
    if (!FIELD_TYPES.some(x => x.value === type)) {
      return alert('種類は text / select / date / checkbox / user のどれかにしてください。')
    }

    const { error } = await supabase.from('app_fields').insert({
      key: `field_${Date.now()}`,
      label: label.trim(),
      field_type: type,
      position: fields.length
    })

    if (error) return alert(error.message)
    loadAll()
  }

  async function editField(item) {
    const label = prompt('項目名', item.label)
    if (!label?.trim()) return

    const { error } = await supabase
      .from('app_fields')
      .update({ label: label.trim(), updated_at: new Date().toISOString() })
      .eq('id', item.id)

    if (error) return alert(error.message)
    loadAll()
  }

  async function toggleRequired(item) {
    const { error } = await supabase
      .from('app_fields')
      .update({
        is_required: !item.is_required,
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id)

    if (error) return alert(error.message)
    loadAll()
  }

  async function toggleActive(item) {
    const { error } = await supabase
      .from('app_fields')
      .update({
        is_active: !item.is_active,
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id)

    if (error) return alert(error.message)
    loadAll()
  }

  async function deleteField(item) {
    if (!confirm(`「${item.label}」を削除しますか？`)) return

    const { error } = await supabase
      .from('app_fields')
      .delete()
      .eq('id', item.id)

    if (error) return alert(error.message)
    loadAll()
  }

  if (!session) return <Login onLogin={login} busy={busy} />

  if (!profile) {
    return <div className="center">確認中...</div>
  }

  if (profile.role !== 'admin') {
    return (
      <div className="center">
        <div className="blocked">
          <h1>One Life Admin</h1>
          <p>このアカウントには管理者権限がありません。</p>
          <button onClick={() => supabase.auth.signOut()}>ログアウト</button>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <div className="brand">One Life Admin</div>
          <div className="tagline">管理者専用</div>
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button
            className="primary"
            onClick={createUser}
            disabled={busy}
          >
            ＋ユーザー
          </button>

          <button className="ghost" onClick={() => supabase.auth.signOut()}>
            ログアウト
          </button>
        </div>
      </header>

      <nav className="tabs">
        <button
          className={tab === 'statuses' ? 'tab active' : 'tab'}
          onClick={() => setTab('statuses')}
        >
          ステータス
        </button>
        <button
          className={tab === 'fields' ? 'tab active' : 'tab'}
          onClick={() => setTab('fields')}
        >
          管理項目
        </button>
      </nav>

      {tab === 'statuses' ? (
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>ステータス管理</h2>
              <p>利用側のページ名・順番を管理します。</p>
            </div>
            <button className="primary" onClick={addStatus}>＋ 追加</button>
          </div>

          <div className="list">
            {statuses.map((item, index) => (
              <div className="row" key={item.id}>
                <div className="row-main">
                  <strong>{item.label}</strong>
                  <small>{item.key}</small>
                </div>

                <div className="row-actions">
                  <button disabled={index === 0} onClick={() => moveStatus(item, 'up')}>↑</button>
                  <button disabled={index === statuses.length - 1} onClick={() => moveStatus(item, 'down')}>↓</button>
                  <button onClick={() => renameStatus(item)}>名前</button>
                  <button className="danger-mini" onClick={() => deleteStatus(item)}>削除</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>管理項目</h2>
              <p>担当者・優先度・締切などを追加できます。</p>
            </div>
            <button className="primary" onClick={addField}>＋ 追加</button>
          </div>

          <div className="list">
            {fields.map(item => (
              <div className="row field-row" key={item.id}>
                <div className="row-main">
                  <strong>{item.label}</strong>
                  <small>
                    {FIELD_TYPES.find(x => x.value === item.field_type)?.label || item.field_type}
                    {item.is_required ? ' / 必須' : ''}
                    {!item.is_active ? ' / 非表示' : ''}
                  </small>
                </div>

                <div className="row-actions wrap">
                  <button onClick={() => editField(item)}>名前</button>
                  <button onClick={() => toggleRequired(item)}>
                    {item.is_required ? '必須解除' : '必須'}
                  </button>
                  <button onClick={() => toggleActive(item)}>
                    {item.is_active ? '非表示' : '表示'}
                  </button>
                  <button className="danger-mini" onClick={() => deleteField(item)}>削除</button>
                </div>
              </div>
            ))}
          </div>
        </section>
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
        <div className="brand big">One Life Admin</div>
        <div className="tagline">管理者専用</div>

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

        <button disabled={busy} onClick={() => onLogin(username, password)}>
          {busy ? 'ログイン中...' : 'ログイン'}
        </button>
      </div>
    </div>
  )
}
