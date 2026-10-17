"use client";

import { motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { Navbar } from "@/components/navbar";
import { ANDROID_BETA_URL } from "@/lib/deeplink";

const TESTFLIGHT_URL = process.env.NEXT_PUBLIC_APP_DOWNLOAD_URL ?? "";
const FARCASTER_PROFILE_URL = "https://farcaster.xyz/jukeaudio";
const FARCASTER_URL = "https://www.farcaster.xyz";

/* ── Platform icons ── */
function AppleIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6" aria-hidden="true">
      <path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function AndroidIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className="h-6 w-6" aria-hidden="true">
      <path d="M17.6 9.48l1.84-3.18c.16-.31.04-.69-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24c-2.86-1.21-6.08-1.21-8.94 0L5.65 5.67c-.19-.29-.58-.38-.87-.2-.28.18-.37.54-.22.83L6.4 9.48C3.3 11.25 1.28 14.44 1 18h22c-.28-3.56-2.3-6.75-5.4-8.52zM7 15.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25zm10 0c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25z" />
    </svg>
  );
}

/* ── App-store-style download badge ── */
function DownloadBadge({
  href,
  icon,
  eyebrow,
  label,
  variant = "navy",
}: {
  href: string;
  icon: React.ReactNode;
  eyebrow: string;
  label: string;
  variant?: "navy" | "cream";
}) {
  const colors =
    variant === "navy"
      ? "bg-juke-navy text-juke-text-on-dark hover:bg-juke-surface focus-visible:ring-offset-juke-cream"
      : "bg-juke-cream text-juke-text-primary hover:bg-white focus-visible:ring-offset-juke-navy";
  const eyebrowColor =
    variant === "navy" ? "text-juke-text-on-dark-secondary" : "text-juke-text-tertiary";

  return (
    <motion.a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`inline-flex items-center gap-3 rounded-2xl py-3 pl-5 pr-6 transition-colors focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 ${colors}`}
      whileTap={{ scale: 0.97 }}
    >
      {icon}
      <span className="flex flex-col text-left leading-tight">
        <span className={`text-[11px] font-medium uppercase tracking-wide ${eyebrowColor}`}>
          {eyebrow}
        </span>
        <span className="text-base font-bold">{label}</span>
      </span>
    </motion.a>
  );
}

/* ── iPhone frame with floating social layer ── */
const FLOATING_REACTIONS = [
  { emoji: "🔥", className: "-right-6 top-[14%]", delay: 0 },
  { emoji: "👏", className: "-left-10 top-[42%]", delay: 1.3 },
  { emoji: "💜", className: "-right-9 bottom-[22%]", delay: 2.2 },
];

function PhoneShowcase() {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="relative mx-auto w-[260px] sm:w-[290px]" aria-hidden="true">
      <div style={{ transform: "perspective(1200px) rotateY(-3deg) rotateX(1.5deg)" }}>
        {/* Device bezel */}
        <div className="relative rounded-[3rem] bg-[#1a1a1e] p-[10px] shadow-2xl shadow-black/50 ring-1 ring-white/[0.08]">
          <div className="absolute -left-[2px] top-28 h-8 w-[3px] rounded-l-sm bg-[#2a2a2e]" />
          <div className="absolute -left-[2px] top-40 h-12 w-[3px] rounded-l-sm bg-[#2a2a2e]" />
          <div className="absolute -left-[2px] top-[13.5rem] h-12 w-[3px] rounded-l-sm bg-[#2a2a2e]" />
          <div className="absolute -right-[2px] top-32 h-16 w-[3px] rounded-r-sm bg-[#2a2a2e]" />

          <div className="relative overflow-hidden rounded-[2.25rem]">
            <Image
              src="/screenshot.PNG"
              alt="Juke app showing a live audio space"
              width={580}
              height={1258}
              sizes="(max-width: 640px) 260px, 290px"
              className="block w-full"
              priority
            />
          </div>
        </div>
      </div>

      {/* Live listeners pill */}
      <div className="absolute -left-5 top-16 flex items-center gap-2 rounded-full bg-white py-2 pl-3 pr-4 shadow-xl shadow-juke-navy/10 ring-1 ring-juke-navy/[0.06] sm:-left-14">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-juke-orange opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-juke-orange" />
        </span>
        <span className="text-xs font-bold text-juke-text-primary">LIVE</span>
        <span className="text-xs text-juke-text-tertiary">128 listening</span>
      </div>

      {/* Floating emoji reactions, echoing the in-app reaction animation */}
      {FLOATING_REACTIONS.map(({ emoji, className, delay }) => (
        <motion.div
          key={emoji}
          className={`absolute flex h-11 w-11 items-center justify-center rounded-full bg-white text-lg shadow-lg shadow-juke-navy/10 ring-1 ring-juke-navy/[0.06] ${className}`}
          animate={shouldReduceMotion ? undefined : { y: [0, -10, 0] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay }}
        >
          {emoji}
        </motion.div>
      ))}

      {/* Glow behind phone */}
      <div className="pointer-events-none absolute -inset-16 -z-10 rounded-full bg-juke-purple/[0.07] blur-3xl" />
    </div>
  );
}

/* ── Equalizer divider bridging cream → navy ── */
const EQ_BAR_COUNT = 36;
const EQ_COLOR_STOPS = ["#D85A30", "#C95B55", "#B45C7F", "#9C5EA6", "#855DCD"];

function equalizerBarColor(index: number): string {
  const stop = Math.round((index / (EQ_BAR_COUNT - 1)) * (EQ_COLOR_STOPS.length - 1));
  return EQ_COLOR_STOPS[stop];
}

function equalizerBarHeight(index: number): number {
  return 0.35 + 0.65 * Math.abs(Math.sin(index * 1.7));
}

function EqualizerDivider() {
  return (
    <div
      className="flex h-40 items-center justify-center gap-1.5 bg-gradient-to-b from-juke-cream to-juke-navy px-6 sm:h-52"
      aria-hidden="true"
    >
      {Array.from({ length: EQ_BAR_COUNT }, (_, i) => (
        <div
          key={i}
          className="juke-eq-bar w-1.5 rounded-full sm:w-2"
          style={{
            height: `${Math.round(equalizerBarHeight(i) * 72)}px`,
            backgroundColor: equalizerBarColor(i),
            animationDelay: `${i * 70}ms`,
            animationDuration: `${1200 + (i % 5) * 150}ms`,
          }}
        />
      ))}
    </div>
  );
}

/* ── Feature icons ── */
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 1.5a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0v-6a3 3 0 0 0-3-3Z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 10.5a7.5 7.5 0 0 1-15 0" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 18v3.75m-3.75 0h7.5" />
    </svg>
  );
}

function FeedIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25H12" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-7 h-7" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" />
    </svg>
  );
}

const features = [
  {
    icon: <MicIcon />,
    title: "Host live spaces",
    description: "Start a conversation and invite your followers. Real-time audio powered by LiveKit.",
  },
  {
    icon: <FeedIcon />,
    title: "Browse your feed",
    description: "Scroll your Farcaster feed while listening in. Like, reply, and recast without missing a beat.",
  },
  {
    icon: <ChatIcon />,
    title: "Chat in threads",
    description: "Threaded chat alongside every space. Discuss what you're hearing in real time.",
  },
];

export default function LandingPage() {
  const shouldReduceMotion = useReducedMotion();

  const fade = shouldReduceMotion
    ? { hidden: { opacity: 1 }, visible: { opacity: 1 } }
    : { hidden: { opacity: 0, y: 16 }, visible: { opacity: 1, y: 0 } };

  const slideLeft = shouldReduceMotion
    ? { hidden: { opacity: 1 }, visible: { opacity: 1 } }
    : { hidden: { opacity: 0, x: -24 }, visible: { opacity: 1, x: 0 } };

  const scaleIn = shouldReduceMotion
    ? { hidden: { opacity: 1 }, visible: { opacity: 1 } }
    : { hidden: { opacity: 0, scale: 0.95 }, visible: { opacity: 1, scale: 1 } };

  const floatUp = shouldReduceMotion
    ? { hidden: { opacity: 1 }, visible: { opacity: 1 } }
    : { hidden: { opacity: 0, y: 40 }, visible: { opacity: 1, y: 0 } };

  return (
    <>
      <a href="#main-content" className="skip-link">
        Skip to content
      </a>

      <Navbar />

      <main id="main-content" className="overflow-x-hidden">
        {/* ── Hero ── */}
        <section className="relative flex min-h-screen items-center bg-juke-cream px-6 sm:px-12">
          {/* Subtle gradient wash */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute top-0 right-0 h-full w-1/2 bg-gradient-to-l from-juke-purple/[0.05] to-transparent" />
            <div className="absolute bottom-0 left-0 h-1/2 w-full bg-gradient-to-t from-juke-orange/[0.03] to-transparent" />
          </div>

          <div className="relative z-10 mx-auto w-full max-w-5xl pb-20 pt-32 sm:pb-28 sm:pt-36">
            <div className="flex flex-col items-center gap-14 md:flex-row md:items-center md:gap-16 lg:gap-20">
              {/* Left: text content */}
              <motion.div
                className="max-w-xl flex-1"
                initial="hidden"
                animate="visible"
                transition={{ staggerChildren: 0.1 }}
              >
                {/* Beta badge */}
                <motion.div
                  className="mb-6 inline-flex items-center gap-2 rounded-full bg-juke-orange/[0.09] py-1.5 pl-3 pr-4 text-sm font-semibold text-juke-orange ring-1 ring-juke-orange/20"
                  variants={slideLeft}
                  transition={{ duration: 0.5 }}
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-juke-orange" />
                  Open beta on iOS &amp; Android
                </motion.div>

                {/* Headline */}
                <motion.h1
                  className="font-display mb-5 text-[2.75rem] font-bold leading-[1.05] tracking-tight text-juke-text-primary sm:text-6xl lg:text-7xl"
                  variants={fade}
                  transition={{ duration: 0.5 }}
                >
                  Live audio,
                  <br />
                  right in your feed.
                </motion.h1>

                {/* Subheadline */}
                <motion.p
                  className="mb-10 max-w-md text-lg text-juke-text-secondary sm:text-xl"
                  variants={fade}
                  transition={{ duration: 0.5, delay: 0.05 }}
                >
                  Juke brings persistent audio spaces to Farcaster. Host a room, pull up a seat,
                  and keep scrolling — the conversation comes with you.
                </motion.p>

                {/* Download CTAs */}
                <motion.div
                  className="flex flex-col gap-3 sm:flex-row"
                  variants={scaleIn}
                  transition={{ duration: 0.4, delay: 0.1 }}
                >
                  <DownloadBadge
                    href={TESTFLIGHT_URL}
                    icon={<AppleIcon />}
                    eyebrow="Beta on TestFlight"
                    label="Download for iOS"
                  />
                  <DownloadBadge
                    href={ANDROID_BETA_URL}
                    icon={<AndroidIcon />}
                    eyebrow="Beta via Firebase"
                    label="Download for Android"
                  />
                </motion.div>

                <motion.p
                  className="mt-5 text-sm text-juke-text-tertiary"
                  variants={fade}
                  transition={{ duration: 0.4, delay: 0.15 }}
                >
                  Or{" "}
                  <Link
                    href="/app"
                    className="font-semibold text-juke-purple underline underline-offset-2 transition-colors hover:text-juke-purple-hover"
                  >
                    launch the web app
                  </Link>{" "}
                  — no download needed.
                </motion.p>
              </motion.div>

              {/* Right: real app screenshot in iPhone frame */}
              <motion.div
                className="flex-shrink-0"
                initial="hidden"
                animate="visible"
                variants={floatUp}
                transition={{ duration: 0.7, delay: 0.3 }}
              >
                <PhoneShowcase />
              </motion.div>
            </div>
          </div>
        </section>

        {/* ── Equalizer transition ── */}
        <EqualizerDivider />

        {/* ── Features ── */}
        <section className="bg-juke-navy px-6 py-24 sm:px-12" aria-labelledby="features-heading">
          <div className="mx-auto max-w-3xl">
            <motion.h2
              id="features-heading"
              className="font-display mb-20 text-3xl font-bold text-juke-text-on-dark sm:text-4xl"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-80px" }}
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Everything in one place
            </motion.h2>

            {/* Stacked feature rows */}
            <div className="space-y-16 sm:space-y-20">
              {features.map((feature, i) => (
                <motion.div
                  key={feature.title}
                  className="group flex items-start gap-5 sm:gap-8"
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true, margin: "-60px" }}
                  variants={slideLeft}
                  transition={{ duration: 0.4, delay: i * 0.08 }}
                >
                  {/* Number + icon */}
                  <div className="flex shrink-0 flex-col items-center gap-2">
                    <span className="text-sm font-semibold tabular-nums text-juke-purple">
                      0{i + 1}
                    </span>
                    <div className="text-juke-text-on-dark-secondary transition-colors group-hover:text-juke-purple">
                      {feature.icon}
                    </div>
                  </div>

                  {/* Text */}
                  <div>
                    <h3 className="font-display mb-1.5 text-xl font-semibold text-juke-text-on-dark sm:text-2xl">
                      {feature.title}
                    </h3>
                    <p className="max-w-md leading-relaxed text-juke-text-on-dark-secondary">
                      {feature.description}
                    </p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        {/* ── Developers ── */}
        <section className="bg-juke-navy px-6 py-24 sm:px-12" aria-labelledby="developers-heading">
          <motion.div
            className="mx-auto max-w-5xl overflow-hidden rounded-3xl bg-juke-surface ring-1 ring-juke-border/60"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-80px" }}
            variants={fade}
            transition={{ duration: 0.5 }}
          >
            <div className="flex flex-col gap-10 p-8 sm:p-12 lg:flex-row lg:items-center lg:gap-16">
              <div className="flex-1">
                <p className="mb-3 text-sm font-semibold uppercase tracking-wide text-juke-orange">
                  For developers
                </p>
                <h2
                  id="developers-heading"
                  className="font-display mb-4 text-3xl font-bold text-juke-text-on-dark sm:text-4xl"
                >
                  Build on Juke
                </h2>
                <p className="mb-8 max-w-md leading-relaxed text-juke-text-on-dark-secondary">
                  Create developer apps and API keys, embed live spaces anywhere, and plug agents
                  into the conversation. The changelog ships as JSON so your tooling can diff it.
                </p>
                <div className="flex flex-wrap items-center gap-4">
                  <Link
                    href="/developers"
                    className="inline-block rounded-full bg-juke-purple px-6 py-3 font-bold text-white transition-colors hover:bg-juke-purple-hover focus-visible:ring-2 focus-visible:ring-juke-purple focus-visible:ring-offset-2 focus-visible:ring-offset-juke-surface"
                  >
                    Open the dashboard
                  </Link>
                  <Link
                    href="/embed/demo"
                    className="font-semibold text-juke-text-on-dark-secondary underline underline-offset-4 transition-colors hover:text-juke-text-on-dark"
                  >
                    See a live embed
                  </Link>
                </div>
              </div>

              {/* Real, working endpoint */}
              <div className="flex-1 lg:max-w-md">
                <div className="rounded-2xl bg-juke-navy p-5 font-mono text-sm leading-relaxed ring-1 ring-juke-border/60">
                  <p className="mb-3 text-juke-text-on-dark-tertiary">
                    <span className="select-none text-juke-orange">$ </span>curl
                    juke.audio/changelog.json
                  </p>
                  <p className="text-juke-text-on-dark-secondary">{"{"}</p>
                  <p className="pl-4 text-juke-text-on-dark-secondary">
                    <span className="text-juke-purple">&quot;canonical_spec&quot;</span>:{" "}
                    <a
                      href="/llms.txt"
                      className="underline underline-offset-2 transition-colors hover:text-juke-text-on-dark"
                    >
                      &quot;juke.audio/llms.txt&quot;
                    </a>
                    ,
                  </p>
                  <p className="pl-4 text-juke-text-on-dark-secondary">
                    <span className="text-juke-purple">&quot;entries&quot;</span>: [
                    <a
                      href="/changelog.json"
                      className="underline underline-offset-2 transition-colors hover:text-juke-text-on-dark"
                    >
                      …
                    </a>
                    ]
                  </p>
                  <p className="text-juke-text-on-dark-secondary">{"}"}</p>
                </div>
              </div>
            </div>
          </motion.div>
        </section>

        {/* ── Footer CTA ── */}
        <section className="bg-juke-navy px-6 py-24 sm:px-12" aria-labelledby="cta-heading">
          <motion.div
            className="mx-auto max-w-3xl text-center"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            transition={{ staggerChildren: 0.1 }}
          >
            <motion.h2
              id="cta-heading"
              className="font-display mb-4 text-3xl font-bold text-juke-text-on-dark sm:text-5xl"
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Pull up a seat
            </motion.h2>

            <motion.p
              className="mx-auto mb-10 max-w-lg text-juke-text-on-dark-secondary"
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Juke is in beta on iPhone and Android. Join the cohort and help shape the future of
              audio on Farcaster.
            </motion.p>

            <motion.div
              className="flex flex-col items-center justify-center gap-3 sm:flex-row"
              variants={scaleIn}
              transition={{ duration: 0.4 }}
            >
              <DownloadBadge
                href={TESTFLIGHT_URL}
                icon={<AppleIcon />}
                eyebrow="Beta on TestFlight"
                label="Download for iOS"
                variant="cream"
              />
              <DownloadBadge
                href={ANDROID_BETA_URL}
                icon={<AndroidIcon />}
                eyebrow="Beta via Firebase"
                label="Download for Android"
                variant="cream"
              />
            </motion.div>

            <motion.p
              className="mt-16 text-sm text-juke-text-on-dark-tertiary"
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Built on{" "}
              <a
                href={FARCASTER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-2 transition-colors hover:text-juke-text-on-dark-secondary"
              >
                Farcaster
              </a>
            </motion.p>
          </motion.div>
        </section>

        {/* ── Footer ── */}
        <footer className="border-t border-juke-border/30 bg-juke-navy px-6 py-14 sm:px-12">
          <div className="mx-auto max-w-5xl">
            <div className="flex flex-col gap-10 sm:flex-row sm:justify-between">
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <Image
                    src="/logomark.png"
                    alt=""
                    width={64}
                    height={64}
                    sizes="28px"
                    className="h-7 w-7 brightness-0 invert"
                  />
                  <span className="font-display text-base font-bold tracking-[0.18em] text-juke-text-on-dark">
                    JUKE
                  </span>
                </div>
                <p className="max-w-xs text-sm text-juke-text-on-dark-tertiary">
                  Live audio spaces for Farcaster.
                </p>
              </div>

              <nav className="grid grid-cols-2 gap-10 sm:grid-cols-3 sm:gap-16" aria-label="Footer">
                <div>
                  <p className="mb-3 text-sm font-semibold text-juke-text-on-dark">Product</p>
                  <ul className="space-y-2 text-sm text-juke-text-on-dark-tertiary">
                    <li>
                      <Link href="/app" className="transition-colors hover:text-juke-text-on-dark-secondary">
                        Launch app
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/leaderboard"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        Leaderboard
                      </Link>
                    </li>
                    <li>
                      <a
                        href={TESTFLIGHT_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        iOS beta
                      </a>
                    </li>
                    <li>
                      <a
                        href={ANDROID_BETA_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        Android beta
                      </a>
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="mb-3 text-sm font-semibold text-juke-text-on-dark">Developers</p>
                  <ul className="space-y-2 text-sm text-juke-text-on-dark-tertiary">
                    <li>
                      <Link
                        href="/developers"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        Dashboard
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/embed/demo"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        Embed demo
                      </Link>
                    </li>
                    <li>
                      <a href="/changelog.json" className="transition-colors hover:text-juke-text-on-dark-secondary">
                        Changelog
                      </a>
                    </li>
                    <li>
                      <a href="/llms.txt" className="transition-colors hover:text-juke-text-on-dark-secondary">
                        llms.txt
                      </a>
                    </li>
                  </ul>
                </div>

                <div>
                  <p className="mb-3 text-sm font-semibold text-juke-text-on-dark">Elsewhere</p>
                  <ul className="space-y-2 text-sm text-juke-text-on-dark-tertiary">
                    <li>
                      <a
                        href={FARCASTER_PROFILE_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        @jukeaudio
                      </a>
                    </li>
                    <li>
                      <a
                        href={FARCASTER_URL}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="transition-colors hover:text-juke-text-on-dark-secondary"
                      >
                        Farcaster
                      </a>
                    </li>
                  </ul>
                </div>
              </nav>
            </div>

            <p className="mt-12 text-sm text-juke-text-on-dark-tertiary">&copy; 2026 Juke</p>
          </div>
        </footer>
      </main>
    </>
  );
}
