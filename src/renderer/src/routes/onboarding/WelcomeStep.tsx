import welcomeBackground from '../../assets/welcome_background.png'

/**
 * First screen of the first-run experience: a full-bleed image with a single
 * greeting and one way forward. The scrim only covers the lower half so the
 * artwork stays readable while the text keeps its contrast.
 */
export function WelcomeStep({ onContinue }: { onContinue: () => void }): JSX.Element {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <img
        src={welcomeBackground}
        alt=""
        aria-hidden
        className="absolute inset-0 h-full w-full object-cover"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/25 to-transparent" />

      <div className="relative flex h-full w-full flex-col items-center justify-end gap-7 px-8 pb-20">
        <h1 className="animate-fade-in text-5xl font-bold tracking-tight text-white drop-shadow-[0_2px_20px_rgba(0,0,0,0.55)]">
          Aloha 👋
        </h1>

        <button
          onClick={onContinue}
          className="press-scale animate-fade-in flex h-10 items-center justify-center rounded-lg bg-white px-6 text-sm font-medium text-black hover:bg-white/90"
        >
          Continue
        </button>
      </div>
    </div>
  )
}
