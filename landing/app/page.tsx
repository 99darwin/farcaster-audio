"use client";

import { motion, useReducedMotion } from "framer-motion";
import Image from "next/image";

const TESTFLIGHT_URL = "https://testflight.apple.com/join/YOUR_TESTFLIGHT_CODE";

/* ── iPhone Frame ── */
function IPhoneFrame() {
  return (
    <div
      className="relative mx-auto w-[260px] sm:w-[290px]"
      aria-hidden="true"
      style={{ transform: "perspective(1200px) rotateY(-3deg) rotateX(1.5deg)" }}
    >
      {/* Device bezel */}
      <div className="relative rounded-[3rem] bg-[#1a1a1e] p-[10px] shadow-2xl shadow-black/50 ring-1 ring-white/[0.08]">
        {/* Side button accents */}
        <div className="absolute -left-[2px] top-28 h-8 w-[3px] rounded-l-sm bg-[#2a2a2e]" />
        <div className="absolute -left-[2px] top-40 h-12 w-[3px] rounded-l-sm bg-[#2a2a2e]" />
        <div className="absolute -left-[2px] top-[13.5rem] h-12 w-[3px] rounded-l-sm bg-[#2a2a2e]" />
        <div className="absolute -right-[2px] top-32 h-16 w-[3px] rounded-r-sm bg-[#2a2a2e]" />

        {/* Screen */}
        <div className="relative overflow-hidden rounded-[2.25rem]">
          <Image
            src="/screenshot.PNG"
            alt="Juke app showing a live audio space"
            width={580}
            height={1258}
            sizes="(max-width: 640px) 260px, 290px"
            className="block w-full"
          />
        </div>
      </div>

      {/* Glow behind phone */}
      <div className="pointer-events-none absolute -inset-16 -z-10 rounded-full bg-juke-purple/[0.07] blur-3xl" />
    </div>
  );
}

/* ── Icon Components ── */
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

      <main id="main-content" className="overflow-x-hidden">
        {/* ── Hero ── */}
        <section className="relative min-h-screen flex items-center bg-juke-cream px-6 sm:px-12">
          {/* Subtle gradient wash */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute top-0 right-0 h-full w-1/2 bg-gradient-to-l from-juke-purple/[0.05] to-transparent" />
            <div className="absolute bottom-0 left-0 h-1/2 w-full bg-gradient-to-t from-juke-orange/[0.03] to-transparent" />
          </div>

          <div className="relative z-10 mx-auto w-full max-w-5xl py-20 sm:py-28">
            <div className="flex flex-col items-center gap-12 md:flex-row md:items-center md:gap-16 lg:gap-20">
              {/* Left: text content */}
              <motion.div
                className="flex-1 max-w-xl"
                initial="hidden"
                animate="visible"
                transition={{ staggerChildren: 0.1 }}
              >
                {/* Logo: waveform mark + JUKE text */}
                <motion.div
                  className="mb-8 flex items-center gap-2.5"
                  variants={slideLeft}
                  transition={{ duration: 0.5 }}
                >
                  <Image
                    src="/logomark.png"
                    alt=""
                    width={96}
                    height={96}
                    sizes="48px"
                    className="h-10 w-10 brightness-0 sm:h-12 sm:w-12"
                    priority
                  />
                  <span className="text-2xl font-bold tracking-[0.2em] text-juke-text-primary sm:text-3xl">
                    JUKE
                  </span>
                </motion.div>

                {/* Headline */}
                <motion.h1
                  className="mb-5 text-4xl font-bold leading-tight tracking-tight text-juke-text-primary sm:text-5xl lg:text-6xl"
                  variants={fade}
                  transition={{ duration: 0.5 }}
                >
                  Live audio on Farcaster
                </motion.h1>

                {/* Subheadline */}
                <motion.p
                  className="mb-10 max-w-md text-lg text-juke-text-secondary sm:text-xl"
                  variants={fade}
                  transition={{ duration: 0.5, delay: 0.05 }}
                >
                  Host spaces, browse your feed, and vibe with your community — all in one app.
                </motion.p>

                {/* CTA */}
                <motion.a
                  href={TESTFLIGHT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block rounded-full bg-juke-purple px-8 py-3.5 text-lg font-bold text-white transition-colors hover:bg-juke-purple-hover focus-visible:ring-2 focus-visible:ring-juke-purple focus-visible:ring-offset-2 focus-visible:ring-offset-juke-cream"
                  variants={scaleIn}
                  whileTap={{ scale: 0.98 }}
                  transition={{ duration: 0.4, delay: 0.1 }}
                >
                  Join the Beta on iOS
                </motion.a>

                <motion.p
                  className="mt-4 text-sm text-juke-text-tertiary"
                  variants={fade}
                  transition={{ duration: 0.4, delay: 0.15 }}
                >
                  Available on iPhone. Android coming soon.
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
                <IPhoneFrame />
              </motion.div>
            </div>
          </div>
        </section>

        {/* ── Gradient transition ── */}
        <div className="h-32 sm:h-48 bg-gradient-to-b from-juke-cream to-juke-navy" aria-hidden="true" />

        {/* ── Features ── */}
        <section className="bg-juke-navy py-24 px-6 sm:px-12" aria-labelledby="features-heading">
          <div className="mx-auto max-w-3xl">
            <motion.h2
              id="features-heading"
              className="mb-20 text-3xl font-bold text-juke-text-on-dark sm:text-4xl"
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
                    <div className="text-juke-text-on-dark-secondary group-hover:text-juke-purple transition-colors">
                      {feature.icon}
                    </div>
                  </div>

                  {/* Text */}
                  <div>
                    <h3 className="mb-1.5 text-xl font-semibold text-juke-text-on-dark sm:text-2xl">
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

        {/* ── Footer CTA ── */}
        <section className="bg-juke-navy py-24 px-6 sm:px-12" aria-labelledby="cta-heading">
          <motion.div
            className="mx-auto max-w-3xl"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-50px" }}
            transition={{ staggerChildren: 0.1 }}
          >
            <motion.h2
              id="cta-heading"
              className="mb-4 text-3xl font-bold text-juke-text-on-dark sm:text-4xl"
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Get early access
            </motion.h2>

            <motion.p
              className="mb-8 max-w-lg text-juke-text-on-dark-secondary"
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Juke is in beta on iPhone. Join via TestFlight and help shape the future of audio on Farcaster. Android coming soon.
            </motion.p>

            <motion.a
              href={TESTFLIGHT_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block rounded-full bg-juke-orange px-8 py-3.5 text-lg font-bold text-white transition-colors hover:bg-juke-orange-hover focus-visible:ring-2 focus-visible:ring-juke-orange focus-visible:ring-offset-2 focus-visible:ring-offset-juke-navy"
              variants={scaleIn}
              whileTap={{ scale: 0.98 }}
              transition={{ duration: 0.4 }}
            >
              Download on TestFlight
            </motion.a>

            <motion.p
              className="mt-16 text-sm text-juke-text-on-dark-tertiary"
              variants={fade}
              transition={{ duration: 0.4 }}
            >
              Built on{" "}
              <a
                href="https://www.farcaster.xyz"
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
        <footer className="bg-juke-navy border-t border-juke-border/30 py-5 px-6 sm:px-12">
          <div className="mx-auto max-w-5xl flex items-center justify-between text-sm text-juke-text-on-dark-tertiary">
            <span>&copy; 2026 Juke</span>
            <a
              href="https://farcaster.xyz/jukeaudio"
              target="_blank"
              rel="noopener noreferrer"
              className="py-2 px-1 transition-colors hover:text-juke-text-on-dark-secondary"
            >
              @jukeaudio on Farcaster
            </a>
          </div>
        </footer>
      </main>
    </>
  );
}
