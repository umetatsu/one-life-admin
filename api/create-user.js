export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST')
    return res.status(405).json({ error: 'Method not allowed' })
  }

  const supabaseUrl = process.env.SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !serviceRoleKey) {
    return res.status(500).json({ error: 'Server configuration is missing' })
  }

  const authHeader = req.headers.authorization || ''
  const accessToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : ''

  if (!accessToken) {
    return res.status(401).json({ error: 'Login required' })
  }

  const adminHeaders = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`
  }

  try {
    // 1) 呼び出した本人を確認
    const userResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${accessToken}`
      }
    })

    if (!userResponse.ok) {
      return res.status(401).json({ error: 'Invalid session' })
    }

    const caller = await userResponse.json()

    // 2) profiles で admin か確認
    const profileResponse = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(caller.id)}&select=id,role`,
      { headers: adminHeaders }
    )

    if (!profileResponse.ok) {
      return res.status(500).json({ error: 'Could not verify admin role' })
    }

    const profiles = await profileResponse.json()

    if (!profiles?.length || profiles[0].role !== 'admin') {
      return res.status(403).json({ error: 'Admin only' })
    }

    const username = String(req.body?.username || '').trim()
    const email = String(req.body?.email || '').trim().toLowerCase()
    const password = String(req.body?.password || '')

    if (!username) {
      return res.status(400).json({ error: 'ユーザー名を入力してください' })
    }

    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'ログイン用メール形式が不正です' })
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'パスワードは6文字以上にしてください' })
    }

    // 3) Supabase Auth に新しいユーザーを作成
    const createResponse = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { username }
      })
    })

    const created = await createResponse.json()

    if (!createResponse.ok) {
      return res.status(createResponse.status).json({
        error:
          created?.msg ||
          created?.message ||
          created?.error ||
          'ユーザー作成に失敗しました'
      })
    }

    const newUserId = created.id || created.user?.id

    if (!newUserId) {
      return res.status(500).json({ error: 'ユーザーIDを取得できませんでした' })
    }

    // 4) Auth作成時のトリガーなどで profile が既に作られているか確認
    const existingProfileResponse = await fetch(
      `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(newUserId)}&select=*`,
      { headers: adminHeaders }
    )

    let existingProfiles = []

    if (existingProfileResponse.ok) {
      existingProfiles = await existingProfileResponse.json()
    }

    // 既に profile がある場合は role だけ user に揃える
    if (existingProfiles?.length) {
      const patchResponse = await fetch(
        `${supabaseUrl}/rest/v1/profiles?id=eq.${encodeURIComponent(newUserId)}`,
        {
          method: 'PATCH',
          headers: {
            ...adminHeaders,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({ role: 'member' })
        }
      )

      if (!patchResponse.ok) {
        const detail = await patchResponse.text()
        return res.status(500).json({
          error: 'プロフィール更新に失敗しました',
          detail
        })
      }

      return res.status(200).json({
        ok: true,
        user: { id: newUserId, username, email }
      })
    }

    // 5) profile が無い場合は新規作成
    // まず username 列がある構成を試す
    let profileInsertResponse = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
      method: 'POST',
      headers: {
        ...adminHeaders,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({
        id: newUserId,
        username,
        role: 'member'
      })
    })

    // username 列が無い構成なら id + role だけで再試行
    if (!profileInsertResponse.ok) {
      const firstDetail = await profileInsertResponse.text()

      if (
        firstDetail.includes('username') &&
        (
          firstDetail.includes('column') ||
          firstDetail.includes('schema cache')
        )
      ) {
        profileInsertResponse = await fetch(`${supabaseUrl}/rest/v1/profiles`, {
          method: 'POST',
          headers: {
            ...adminHeaders,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
          },
          body: JSON.stringify({
            id: newUserId,
            role: 'member'
          })
        })
      } else {
        await fetch(`${supabaseUrl}/auth/v1/admin/users/${newUserId}`, {
          method: 'DELETE',
          headers: adminHeaders
        })

        return res.status(500).json({
          error: 'プロフィール作成に失敗しました',
          detail: firstDetail
        })
      }
    }

    if (!profileInsertResponse.ok) {
      const detail = await profileInsertResponse.text()

      await fetch(`${supabaseUrl}/auth/v1/admin/users/${newUserId}`, {
        method: 'DELETE',
        headers: adminHeaders
      })

      return res.status(500).json({
        error: 'プロフィール作成に失敗しました',
        detail
      })
    }

    return res.status(200).json({
      ok: true,
      user: {
        id: newUserId,
        username,
        email
      }
    })
  } catch (error) {
    return res.status(500).json({
      error: error?.message || 'Unexpected server error'
    })
  }
}
