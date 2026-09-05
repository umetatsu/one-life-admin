// ONE LIFE ADMIN USER MANAGEMENT V1
import React, { useEffect, useState } from 'react'
import { supabase, usernameToEmail } from './supabase'

export default function App() {
  const [session, setSession] = useState(null)
  const [profile, setProfile] = useState(null)
  const [statuses, setStatuses] = useState([])
  const [users, setUsers] = useState([])
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

  async function getAccessToken() {
    const { data } = await supabase.auth.getSession()
    return data?.session?.access_token || ''
  }

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
    await Promise.all([loadStatuses(), loadUsers()])
  }

  async function loadStatuses() {
    const { data, error } = await supabase
      .from('app_statuses')
      .select('*')
      .order('position')

    if (error) {
      alert(`ステータス取得失敗: ${error.message}`)
      return
    }

    setStatuses(data || [])
  }

  async function loadUsers() {
    try {
      const accessToken = await getAccessToken()

      if (!accessToken) {
        alert('ログイン情報を確認できませんでした。')
        return
      }

      const response = await fetch('/api/users', {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        alert(`ユーザー一覧取得失敗: ${result?.error || '不明なエラー'}`)
        return
      }

      setUsers(result.users || [])
    } catch (error) {
      alert(`ユーザー一覧取得失敗: ${error?.message || error}`)
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

  async function logout() {
    setProfile(null)
    setSession(null)

    supabase.auth.signOut({ scope: 'local' }).catch(error => {
      console.error('logout failed', error)
    })
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
      const accessToken = await getAccessToken()

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
      await loadUsers()
    } catch (error) {
      alert(`ユーザー作成に失敗しました: ${error?.message || error}`)
    } finally {
      setBusy(false)
    }
  }

  async function deleteUser(item) {
    if (!item?.id) return

    if (item.id === session?.user?.id) {
      alert('現在ログイン中の管理者は削除できません。')
      return
    }

    if (!confirm(`「${item.username}」を削除しますか？`)) return

    setBusy(true)

    try {
      const accessToken = await getAccessToken()

      const response = await fetch('/api/users', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ id: item.id })
      })

      const result = await response.json().catch(() => ({}))

      if (!response.ok) {
        alert(`ユーザー削除に失敗しました: ${result?.error || '不明なエラー'}`)
        return
      }

      await loadUsers()
    } catch (error) {
      alert(`ユーザー削除に失敗しました: ${error?.message || error}`)
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

    loadStatuses()
  }

  async function renameStatus(item) {
    const label = prompt('新しい名前', item.label)
    if (!label?.trim() || label.trim() === item.label) return

    const { error } = await supabase
      .from('app_statuses')
      .update({
        label: label.trim(),
        updated_at: new Date().toISOString()
      })
      .eq('id', item.id)

    if (error) return alert(error.message)

    loadStatuses()
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

    loadStatuses()
  }

  async function moveStatus(item, direction) {
    const index = statuses.findIndex(x => x.id === item.id)
    const targetIndex = direction === 'up' ? index - 1 : index + 1

    if (targetIndex < 0 || targetIndex >= statuses.length) return

    const target = statuses[targetIndex]

    await Promise.all([
      supabase
        .from('app_statuses')
        .update({ position: target.position })
        .eq('id', item.id),
      supabase
        .from('app_statuses')
        .update({ position: item.position })
        .eq('id', target.id)
    ])

    loadStatuses()
  }

  if (!session) {
    return <Login onLogin={login} busy={busy} />
  }

  if (!profile) {
    return <div className="center">確認中...</div>
  }

  if (profile.role !== 'admin') {
    return (
      <div className="center">
        <div className="blocked">
          <h1>One Life Admin</h1>
          <p>このアカウントには管理者権限がありません。</p>
          <button onClick={logout}>ログアウト</button>
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

          <button className="ghost" onClick={logout}>
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
          className={tab === 'users' ? 'tab active' : 'tab'}
          onClick={() => setTab('users')}
        >
          ユーザー管理
        </button>
      </nav>

      {tab === 'statuses' ? (
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>ステータス管理</h2>
              <p>利用側のページ名・順番を管理します。</p>
            </div>

            <button className="primary" onClick={addStatus}>
              ＋ 追加
            </button>
          </div>

          <div className="list">
            {statuses.map((item, index) => (
              <div className="row" key={item.id}>
                <div className="row-main">
                  <strong>{item.label}</strong>
                  <small>{item.key}</small>
                </div>

                <div className="row-actions">
                  <button
                    disabled={index === 0}
                    onClick={() => moveStatus(item, 'up')}
                  >
                    ↑
                  </button>

                  <button
                    disabled={index === statuses.length - 1}
                    onClick={() => moveStatus(item, 'down')}
                  >
                    ↓
                  </button>

                  <button onClick={() => renameStatus(item)}>
                    名前
                  </button>

                  <button
                    className="danger-mini"
                    onClick={() => deleteStatus(item)}
                  >
                    削除
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="section-head">
            <div>
              <h2>ユーザー管理</h2>
              <p>利用ユーザーの追加・削除を管理します。</p>
            </div>

            <button
              className="primary"
              onClick={createUser}
              disabled={busy}
            >
              ＋ 追加
            </button>
          </div>

          <div className="list">
            {users.map(item => {
              const isMe = item.id === session?.user?.id

              return (
                <div className="row" key={item.id}>
                  <div className="row-main">
                    <strong>
                      {item.username}
                      {isMe ? '（自分）' : ''}
                    </strong>
                    <small>
                      {item.role === 'admin' ? '管理者' : 'ユーザー'}
                    </small>
                  </div>

                  <div className="row-actions">
                    <button
                      className="danger-mini"
                      disabled={isMe || busy}
                      onClick={() => deleteUser(item)}
                    >
                      {isMe ? '削除不可' : '削除'}
                    </button>
                  </div>
                </div>
              )
            })}

            {!users.length && (
              <div className="row">
                <div className="row-main">
                  <strong>ユーザーがありません</strong>
                </div>
              </div>
            )}
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
