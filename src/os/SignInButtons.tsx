import { signIn, signInWithGoogle, useAccount } from './account'

/** "Sign in with GitHub" and, where this server offers it, "Sign in with Google" (server/auth.ts). */
export function SignInButtons({ className = 'btn btn-primary' }: { className?: string }) {
  const account = useAccount()
  const { github, google } = account.signIn
  return (
    <>
      {(github || !google) && (
        <button className={className} onClick={signIn}>
          Sign in with GitHub
        </button>
      )}
      {google && (
        <button className={className} onClick={signInWithGoogle}>
          Sign in with Google
        </button>
      )}
    </>
  )
}
