import { cn } from "@/components/ui/cn";
import { CasterIcon, CommunityIcon, HostIcon, VoiceIcon } from "./icons";

/**
 * Lists the INPUTS behind placements only — never exact weights or a formula.
 * Publishing the formula makes it gameable and locks in rules we want the
 * freedom to tune monthly at this stage. See spec §2/§3.
 */
const INPUTS = [
  {
    icon: HostIcon,
    label: "Top Hosts",
    description: "Rooms hosted and the listeners they reached.",
  },
  {
    icon: VoiceIcon,
    label: "Top Voices",
    description: "Voice notes published and who they reached.",
  },
  {
    icon: CasterIcon,
    label: "Top Casters",
    description: "Casts shared via Juke and who engaged with them.",
  },
  {
    icon: CommunityIcon,
    label: "Community",
    description: "Speaking in rooms, and replies and reactions given to others.",
  },
];

export function HowPlacementsWork({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl bg-juke-navy/[0.03] p-5 ring-1 ring-juke-navy/[0.07] sm:p-6",
        className,
      )}
    >
      <p className="mb-3 text-sm font-semibold text-juke-text-primary">
        How placements work
      </p>
      <p className="mb-4 text-sm text-juke-text-secondary">
        Each board ranks distinct-person engagement, not raw totals — ten people
        showing up once counts more than one person showing up ten times.
        Placements are reviewed before a cycle closes.
      </p>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {INPUTS.map(({ icon: Icon, label, description }) => (
          <li key={label} className="flex items-start gap-2.5">
            <Icon className="mt-0.5 h-4 w-4 shrink-0 text-juke-orange" />
            <span className="text-sm text-juke-text-secondary">
              <span className="font-semibold text-juke-text-primary">{label}: </span>
              {description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
