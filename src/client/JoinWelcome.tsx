type Props = { code: string; name: string; onName: (value: string) => void; onJoin: (name: string) => void };

export function JoinWelcome({ code, name, onName, onJoin }: Props) {
  return (
    <section className="invite-entry reference-sky" aria-labelledby="invite-title">
      <div className="invite-card">
        <h1 id="invite-title" className="reference-serif">Join the room.</h1>
        {code && <p className="invite-room">Room <span>{code.slice(0, 3)} {code.slice(3)}</span></p>}
        <p className="invite-description">Add a name so the host knows which files are yours.</p>
        <form onSubmit={event => { event.preventDefault(); onJoin(name); }}>
          <label htmlFor="invite-name">Your name <span>(optional)</span></label>
          <input id="invite-name" type="text" name="name" autoComplete="name" autoCapitalize="words"
            enterKeyHint="go" placeholder="e.g. Alex" maxLength={32}
            value={name} onChange={event => onName(event.target.value)} aria-describedby="invite-name-note"/>
          <p id="invite-name-note" className="invite-name-note">This appears alongside the files you share.</p>
          <button type="submit" className="primary-button reference-pill">Join room</button>
          <button type="button" className="invite-skip" onClick={() => onJoin('')}>Skip for now</button>
        </form>
      </div>
    </section>
  );
}
