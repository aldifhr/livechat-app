import { host } from "@/lib/sidecar"

interface Avatar {
  imageUrl: string
  profileUrl: string
  label?: string
}
interface AvatarCirclesProps {
  className?: string
  numPeople?: number
  avatarUrls: Avatar[]
}

export const AvatarCircles = ({
  numPeople,
  className,
  avatarUrls,
}: AvatarCirclesProps) => {
  return (
    <div
      className={["avatar-circles", className].filter(Boolean).join(" ")}
      role="group"
      aria-label="Active chatters"
    >
      {avatarUrls.map((url, index) => (
        <button
          key={index}
          type="button"
          className="avatar-circle"
          title={`Open ${url.label || 'chatter'} profile`}
          aria-label={`Open ${url.label || 'chatter'} profile`}
          onClick={() => void host.openStream(url.profileUrl).catch(() => {})}
        >
          <img
            className="avatar-circle-image"
            src={url.imageUrl}
            width={40}
            height={40}
            alt=""
          />
        </button>
      ))}
      {(numPeople ?? 0) > 0 && (
        <span className="avatar-circle-more" aria-label={`${numPeople} more chatters`}>
          +{numPeople}
        </span>
      )}
    </div>
  )
}
