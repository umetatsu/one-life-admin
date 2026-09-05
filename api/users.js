// ONE LIFE ADMIN USERS API V1
import { createClient } from '@supabase/supabase-js'

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false
    }
  }
)

function getBearerToken(req) {
  const header = req.headers.authorization || ''
  return header.startsWith('Bearer ') ? header.slice(7) : ''
}

async function requireAdmin(req) {
  const token = getBearerToken(req)

  if (!token) {
    return { error: 'ログイン情報がありません。', status: 401 }
  }

  const {
    data: { user },
    error: userError
  } = await supabaseAdmin.auth.getUser(token)

  if (userError || !user) {
    return { error: 'ログイン情報を確認できません。', status: 401 }
  }

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single()

  if (profileError || profile?.role !== 'admin') {
    return { error: '管理者権限がありません。', status: 403 }
  }

  return { user }
}

export default async function handler(req, res) {
  try {
    const auth = await requireAdmin(req)

    if (auth.error) {
      return res.status(auth.status).json({ error: auth.error })
    }

    if (req.method === 'GET') {
      const {
        data: { users },
        error: usersError
      } = await supabaseAdmin.auth.admin.listUsers({
        page: 1,
        perPage: 1000
      })

      if (usersError) {
        return res.status(500).json({ error: usersError.message })
      }

      const ids = users.map(user => user.id)
      let roleMap = {}

      if (ids.length) {
        const { data: profiles, error: profilesError } = await supabaseAdmin
          .from('profiles')
          .select('id, role')
          .in('id', ids)

        if (profilesError) {
          return res.status(500).json({ error: profilesError.message })
        }

        roleMap = Object.fromEntries(
          (profiles || []).map(profile => [profile.id, profile.role])
        )
      }

      const result = users
        .map(user => ({
          id: user.id,
          username: (user.email || '').split('@')[0] || 'unknown',
          role: roleMap[user.id] || 'member',
          created_at: user.created_at
        }))
        .sort((a, b) => {
          if (a.role !== b.role) return a.role === 'admin' ? -1 : 1
          return a.username.localeCompare(b.username)
        })

      return res.status(200).json({ users: result })
    }

    if (req.method === 'DELETE') {
      const id = req.body?.id

      if (!id) {
        return res.status(400).json({ error: '削除するユーザーIDがありません。' })
      }

      if (id === auth.user.id) {
        return res.status(400).json({ error: '現在ログイン中の管理者は削除できません。' })
      }

      const { error: deleteError } =
        await supabaseAdmin.auth.admin.deleteUser(id)

      if (deleteError) {
        return res.status(500).json({ error: deleteError.message })
      }

      return res.status(200).json({ ok: true })
    }

    res.setHeader('Allow', ['GET', 'DELETE'])
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'サーバーエラー'
    })
  }
}
