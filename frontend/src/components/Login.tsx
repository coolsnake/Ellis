import React from 'react'

export const Login: React.FC<{ onSubmit: (creds: { user: string; pass: string }) => void; error?: string | null }> = ({ onSubmit, error }) => {
  const [user, setUser] = React.useState('')
  const [pass, setPass] = React.useState('')
  const [showPass, setShowPass] = React.useState(false)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({ user: user.trim(), pass })
  }

  return (
		<div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: '#0b0f19' }}>
			<form
				onSubmit={handleSubmit}
				className="w-full max-w-sm bg-gray-900 border border-gray-700 rounded-lg p-6 shadow"
				style={{ backgroundColor: '#111827', border: '1px solid #374151', color: '#ffffff' }}
			>
        <h2 className="text-2xl font-semibold text-white mb-4">Lockstone Login</h2>

        <label className="block text-sm font-medium text-gray-300 mb-2">Username</label>
				<input
          type="text"
          value={user}
          onChange={e => setUser(e.target.value)}
          placeholder="Username"
          autoFocus
					className="w-full px-3 py-2 mb-4 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
					style={{ backgroundColor: '#374151', border: '1px solid #4b5563', color: '#ffffff' }}
        />

        <label className="block text-sm font-medium text-gray-300 mb-2">Password</label>
        <div className="flex items-center gap-2">
					<input
            type={showPass ? 'text' : 'password'}
            value={pass}
            onChange={e => setPass(e.target.value)}
            placeholder="Password"
						className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded-md text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
						style={{ backgroundColor: '#374151', border: '1px solid #4b5563', color: '#ffffff' }}
          />
          <button
            type="button"
            onClick={() => setShowPass(s => !s)}
						className="px-2 py-1 text-sm rounded bg-gray-600 hover:bg-gray-700 text-white"
						style={{ backgroundColor: '#4b5563', color: '#ffffff' }}
          >
            {showPass ? 'Hide' : 'Show'}
          </button>
        </div>

				{error ? <div className="mt-3 text-sm text-red-400" style={{ color: '#f87171' }}>{error}</div> : null}

        <button
          type="submit"
					className="mt-4 w-full px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md"
					style={{ backgroundColor: '#2563eb', color: '#ffffff' }}
        >
          Sign in
        </button>
      </form>
    </div>
  )
}
