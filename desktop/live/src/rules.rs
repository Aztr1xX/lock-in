//! Turns what the models saw in each check into what the app cares about: are you here, is a
//! phone in your hand, is someone else in the room, is the camera working.
//!
//! The rules follow the camera plan:
//! - Away: you count as here if either the person box or your shoulders are seen. Away starts
//!   after 15 s with neither, and "back" needs 2 s of steady sightings, so leaning out of frame
//!   or one bad frame never ends a round. Your face is never needed.
//! - Phone: seen near a wrist in 6 of the last 8 checks (about 4 s at two checks a second), and
//!   not tablet-sized (longer than 1.1 shoulder widths). It ends once it drops to 2 of 8.
//! - Interrupted: two or more people for over 20 s; ends after 5 s with one.
//! - Camera health: very dark for 3 s reads as covered, an unchanging picture for 10 s as
//!   frozen. While the camera isn't healthy you are never counted as away.
//! - Room too dark: dim for 10 minutes gives one gentle tip.
//! - Sip: a cup or bottle at your hand in two checks in a row, at most every 5 minutes.

use serde::Serialize;
use std::collections::VecDeque;

/// One check's findings, as the camera worker reported them.
#[derive(Debug, Clone, Default)]
pub struct Look {
    /// Seconds since the camera started.
    pub t: f64,
    pub people: u32,
    pub person: bool,
    pub shoulders: bool,
    pub phone: Option<PhoneSeen>,
    pub drink_at_hand: bool,
    /// Average brightness of the frame, 0 to 255.
    pub brightness: f32,
    /// How different the frame is from the previous one, 0 to 255.
    pub change: f32,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct PhoneSeen {
    pub score: f32,
    pub near_wrist: bool,
    /// The phone's long side divided by your shoulder width, when the shoulders are visible.
    pub long_side_shoulders: Option<f32>,
}

#[derive(Debug, Clone, Copy)]
pub struct Settings {
    /// "Check for my phone". Off means fully off: no counting at all.
    pub phone: bool,
    /// Lowest detector score that counts as a phone sighting.
    pub phone_score: f32,
}

impl Default for Settings {
    fn default() -> Self {
        Settings { phone: true, phone_score: 0.4 }
    }
}

pub const AWAY_AFTER: f64 = 15.0;
pub const BACK_AFTER: f64 = 2.0;
pub const PHONE_WINDOW: usize = 8;
pub const PHONE_ON: usize = 6;
pub const PHONE_OFF: usize = 2;
pub const TABLET_SHOULDERS: f32 = 1.1;
pub const INTERRUPT_AFTER: f64 = 20.0;
pub const INTERRUPT_END: f64 = 5.0;
pub const COVERED_BRIGHTNESS: f32 = 8.0;
pub const COVERED_AFTER: f64 = 3.0;
pub const FROZEN_CHANGE: f32 = 0.05;
pub const FROZEN_AFTER: f64 = 10.0;
pub const DARK_BRIGHTNESS: f32 = 45.0;
pub const DARK_AFTER: f64 = 600.0;
pub const SIP_COOLDOWN: f64 = 300.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Presence {
    Here,
    Away,
    /// The camera can't tell right now (covered or frozen).
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ok,
    Covered,
    Frozen,
}

/// Something that happened, with the time it really started (which can be before the check
/// that confirmed it).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Event {
    Away { at: f64 },
    Back { at: f64, away_secs: f64 },
    PhoneStart { at: f64 },
    PhoneEnd { at: f64, secs: f64 },
    InterruptStart { at: f64 },
    InterruptEnd { at: f64, secs: f64 },
    Health { at: f64, health: Health },
    DarkTip { at: f64 },
    Sip { at: f64 },
}

#[derive(Debug, Clone, Serialize)]
pub struct State {
    pub presence: Presence,
    pub away_since: Option<f64>,
    pub phone: bool,
    /// Phone sightings in the last 8 checks.
    pub phone_hits: usize,
    pub interrupted: bool,
    pub health: Health,
}

pub struct Rules {
    pub settings: Settings,
    presence: Presence,
    last_seen: f64,
    away_since: Option<f64>,
    seen_since: Option<f64>,
    phone_window: VecDeque<bool>,
    phone_since: Option<f64>,
    phone_last_hit: f64,
    last_t: Option<f64>,
    gap: f64,
    crowd_since: Option<f64>,
    alone_since: Option<f64>,
    interrupted_since: Option<f64>,
    health: Health,
    dark_since: Option<f64>,
    still_since: Option<f64>,
    dim_since: Option<f64>,
    dark_tip_given: bool,
    last_drink: bool,
    last_sip: Option<f64>,
}

impl Rules {
    pub fn new(settings: Settings) -> Rules {
        Rules {
            settings,
            presence: Presence::Here,
            last_seen: 0.0,
            away_since: None,
            seen_since: None,
            phone_window: VecDeque::with_capacity(PHONE_WINDOW),
            phone_since: None,
            phone_last_hit: 0.0,
            last_t: None,
            gap: 0.5,
            crowd_since: None,
            alone_since: None,
            interrupted_since: None,
            health: Health::Ok,
            dark_since: None,
            still_since: None,
            dim_since: None,
            dark_tip_given: false,
            last_drink: false,
            last_sip: None,
        }
    }

    pub fn state(&self) -> State {
        State {
            presence: self.presence,
            away_since: self.away_since,
            phone: self.phone_since.is_some(),
            phone_hits: self.phone_window.iter().filter(|&&h| h).count(),
            interrupted: self.interrupted_since.is_some(),
            health: self.health,
        }
    }

    /// Takes one check and returns what changed.
    pub fn update(&mut self, l: &Look) -> Vec<Event> {
        let mut ev = Vec::new();
        let t = l.t;
        if let Some(prev) = self.last_t {
            // Smoothed time between checks (half a second normally, a second on slow PCs).
            self.gap = self.gap * 0.8 + (t - prev).clamp(0.05, 5.0) * 0.2;
        }
        self.last_t = Some(t);
        self.health(l, &mut ev);

        // ---- here or away ----
        let seen = l.person || l.shoulders;
        if self.health != Health::Ok {
            // Can't tell: never count it as away, and start fresh once the picture is back.
            if self.presence != Presence::Unknown {
                self.presence = Presence::Unknown;
            }
            self.last_seen = t;
            self.seen_since = None;
        } else {
            if self.presence == Presence::Unknown {
                // The camera is back. If you were away before, you still are until seen.
                self.presence = if self.away_since.is_some() { Presence::Away } else { Presence::Here };
                self.last_seen = t;
            }
            match self.presence {
                Presence::Here | Presence::Unknown => {
                    if seen {
                        self.last_seen = t;
                    } else if t - self.last_seen >= AWAY_AFTER {
                        self.presence = Presence::Away;
                        self.away_since = Some(self.last_seen);
                        self.seen_since = None;
                        ev.push(Event::Away { at: self.last_seen });
                    }
                }
                Presence::Away => {
                    if seen {
                        let since = *self.seen_since.get_or_insert(t);
                        if t - since >= BACK_AFTER {
                            let away = self.away_since.take().unwrap_or(since);
                            self.presence = Presence::Here;
                            self.last_seen = t;
                            self.seen_since = None;
                            ev.push(Event::Back { at: since, away_secs: since - away });
                        }
                    } else {
                        self.seen_since = None;
                    }
                }
            }
        }

        // ---- phone in hand ----
        let hit = self.settings.phone
            && self.health == Health::Ok
            && l.phone.is_some_and(|p| p.score >= self.settings.phone_score && p.near_wrist && p.long_side_shoulders.is_none_or(|r| r <= TABLET_SHOULDERS));
        if self.phone_window.len() == PHONE_WINDOW {
            self.phone_window.pop_front();
        }
        self.phone_window.push_back(hit);
        if hit {
            self.phone_last_hit = t;
        }
        let hits = self.phone_window.iter().filter(|&&h| h).count();
        match self.phone_since {
            None if hits >= PHONE_ON => {
                // It started at the first sighting in the window.
                let back = self.phone_window.len() - 1 - self.phone_window.iter().position(|&h| h).unwrap_or(0);
                let at = (t - back as f64 * self.gap).max(0.0);
                self.phone_since = Some(at);
                ev.push(Event::PhoneStart { at });
            }
            Some(since) if hits <= PHONE_OFF || !self.settings.phone => {
                // It ended just after the last sighting.
                let at = (self.phone_last_hit + self.gap).min(t);
                self.phone_since = None;
                ev.push(Event::PhoneEnd { at, secs: at - since });
            }
            _ => {}
        }

        // ---- someone else in the room ----
        if l.people >= 2 && self.health == Health::Ok {
            self.alone_since = None;
            let since = *self.crowd_since.get_or_insert(t);
            if self.interrupted_since.is_none() && t - since > INTERRUPT_AFTER {
                self.interrupted_since = Some(since);
                ev.push(Event::InterruptStart { at: since });
            }
        } else {
            self.crowd_since = None;
            if let Some(start) = self.interrupted_since {
                let alone = *self.alone_since.get_or_insert(t);
                if t - alone >= INTERRUPT_END {
                    self.interrupted_since = None;
                    self.alone_since = None;
                    ev.push(Event::InterruptEnd { at: alone, secs: alone - start });
                }
            }
        }

        // ---- a drink ----
        let drink = l.drink_at_hand && self.health == Health::Ok;
        if drink && self.last_drink && self.last_sip.is_none_or(|s| t - s >= SIP_COOLDOWN) {
            self.last_sip = Some(t);
            ev.push(Event::Sip { at: t });
        }
        self.last_drink = drink;
        ev
    }

    fn health(&mut self, l: &Look, ev: &mut Vec<Event>) {
        let t = l.t;
        let covered = if l.brightness < COVERED_BRIGHTNESS { t - *self.dark_since.get_or_insert(t) >= COVERED_AFTER } else {
            self.dark_since = None;
            false
        };
        let frozen = if l.change < FROZEN_CHANGE { t - *self.still_since.get_or_insert(t) >= FROZEN_AFTER } else {
            self.still_since = None;
            false
        };
        let health = if frozen { Health::Frozen } else if covered { Health::Covered } else { Health::Ok };
        if health != self.health {
            self.health = health;
            ev.push(Event::Health { at: t, health });
        }

        if health == Health::Ok && l.brightness < DARK_BRIGHTNESS {
            let since = *self.dim_since.get_or_insert(t);
            if !self.dark_tip_given && t - since >= DARK_AFTER {
                self.dark_tip_given = true;
                ev.push(Event::DarkTip { at: t });
            }
        } else if health == Health::Ok {
            self.dim_since = None;
        }
    }

    /// The camera stopped sending frames entirely (the session noticed a timeout).
    pub fn camera_stalled(&mut self, t: f64) -> Vec<Event> {
        let mut ev = Vec::new();
        if self.health != Health::Frozen {
            self.health = Health::Frozen;
            self.presence = Presence::Unknown;
            ev.push(Event::Health { at: t, health: Health::Frozen });
        }
        // Make sure the next real frame doesn't count as "still frozen" from long ago.
        self.still_since = None;
        ev
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn here(t: f64) -> Look {
        Look { t, people: 1, person: true, shoulders: true, brightness: 120.0, change: 3.0, ..Default::default() }
    }
    fn empty(t: f64) -> Look {
        Look { t, brightness: 120.0, change: 3.0, ..Default::default() }
    }
    /// Runs checks twice a second from `from` to `to` (exclusive), collecting events.
    fn run(r: &mut Rules, from: f64, to: f64, f: impl Fn(f64) -> Look) -> Vec<Event> {
        let mut out = Vec::new();
        let mut t = from;
        while t < to - 1e-9 {
            out.extend(r.update(&f(t)));
            t += 0.5;
        }
        out
    }

    #[test]
    fn away_after_15_seconds_and_back_after_2() {
        let mut r = Rules::new(Settings::default());
        assert!(run(&mut r, 0.0, 10.0, here).is_empty());
        // Gone from 10 s: away is confirmed at 24.5 s (15 s after the last sighting at 9.5 s).
        let ev = run(&mut r, 10.0, 30.0, empty);
        assert_eq!(ev, vec![Event::Away { at: 9.5 }]);
        assert_eq!(r.state().presence, Presence::Away);
        // One glimpse doesn't bring you back.
        assert!(run(&mut r, 30.0, 30.5, here).is_empty());
        assert!(run(&mut r, 30.5, 31.0, empty).is_empty());
        // Two seconds of steady sightings do, dated from when you sat down.
        let ev = run(&mut r, 31.0, 34.0, here);
        assert_eq!(ev, vec![Event::Back { at: 31.0, away_secs: 21.5 }]);
        assert_eq!(r.state().presence, Presence::Here);
    }

    #[test]
    fn leaning_out_or_looking_down_is_not_away() {
        let mut r = Rules::new(Settings::default());
        // Out of frame for 12 s: not away.
        let mut ev = run(&mut r, 0.0, 5.0, here);
        ev.extend(run(&mut r, 5.0, 17.0, empty));
        ev.extend(run(&mut r, 17.0, 20.0, here));
        // Face away, only shoulders seen (reading the iPad): still here.
        ev.extend(run(&mut r, 20.0, 60.0, |t| Look { person: false, shoulders: true, ..here(t) }));
        assert!(ev.is_empty(), "{ev:?}");
    }

    #[test]
    fn phone_needs_6_of_8_near_a_wrist() {
        let mut r = Rules::new(Settings::default());
        let phone = |near: bool, size: Option<f32>| move |t: f64| Look { phone: Some(PhoneSeen { score: 0.7, near_wrist: near, long_side_shoulders: size }), ..here(t) };
        // On the desk, away from the hands: never.
        assert!(run(&mut r, 0.0, 10.0, phone(false, Some(0.5))).is_empty());
        // Tablet-sized: never (the iPad).
        assert!(run(&mut r, 10.0, 30.0, phone(true, Some(1.6))).is_empty());
        // In hand: flagged on the 6th sighting, dated from the first.
        let ev = run(&mut r, 30.0, 33.0, phone(true, Some(0.6)));
        assert_eq!(ev, vec![Event::PhoneStart { at: 30.0 }]);
        assert!(r.state().phone);
        // Put down: ends once only 2 of the last 8 checks saw it.
        let ev = run(&mut r, 33.0, 37.0, here);
        assert_eq!(ev, vec![Event::PhoneEnd { at: 33.0, secs: 3.0 }]);
    }

    #[test]
    fn a_flicker_of_phone_is_ignored_and_off_means_off() {
        let mut r = Rules::new(Settings::default());
        let ev = run(&mut r, 0.0, 30.0, |t| {
            let blink = (t * 2.0) as i64 % 2 == 0; // every other check
            Look { phone: blink.then_some(PhoneSeen { score: 0.9, near_wrist: true, long_side_shoulders: None }), ..here(t) }
        });
        assert!(ev.is_empty(), "4 of 8 is not enough: {ev:?}");
        let mut off = Rules::new(Settings { phone: false, ..Settings::default() });
        let ev = run(&mut off, 0.0, 10.0, |t| Look { phone: Some(PhoneSeen { score: 0.9, near_wrist: true, long_side_shoulders: None }), ..here(t) });
        assert!(ev.is_empty());
        assert_eq!(off.state().phone_hits, 0);
    }

    #[test]
    fn someone_else_for_20_seconds_is_an_interruption() {
        let mut r = Rules::new(Settings::default());
        let two = |t: f64| Look { people: 2, ..here(t) };
        assert!(run(&mut r, 0.0, 15.0, two).is_empty());
        assert!(run(&mut r, 15.0, 20.0, here).is_empty(), "a parent popping in for 15 s");
        let ev = run(&mut r, 20.0, 45.0, two);
        assert_eq!(ev, vec![Event::InterruptStart { at: 20.0 }]);
        let ev = run(&mut r, 45.0, 52.0, here);
        assert_eq!(ev, vec![Event::InterruptEnd { at: 45.0, secs: 25.0 }]);
    }

    #[test]
    fn covered_or_frozen_camera_is_not_away() {
        let mut r = Rules::new(Settings::default());
        run(&mut r, 0.0, 5.0, here);
        let ev = run(&mut r, 5.0, 40.0, |t| Look { brightness: 2.0, ..empty(t) });
        assert_eq!(ev, vec![Event::Health { at: 8.0, health: Health::Covered }]);
        assert_eq!(r.state().presence, Presence::Unknown);
        let ev = run(&mut r, 40.0, 42.0, here);
        assert_eq!(ev, vec![Event::Health { at: 40.0, health: Health::Ok }]);
        assert_eq!(r.state().presence, Presence::Here);

        // The same picture over and over for 10 s: frozen, still not away.
        let ev = run(&mut r, 42.0, 70.0, |t| Look { change: 0.0, ..empty(t) });
        assert_eq!(ev, vec![Event::Health { at: 52.0, health: Health::Frozen }]);
        // Sitting very still with a live camera has sensor noise, so it never reads as frozen.
        let mut r = Rules::new(Settings::default());
        assert!(run(&mut r, 0.0, 120.0, |t| Look { change: 0.4, ..here(t) }).is_empty());
    }

    #[test]
    fn dark_room_tip_once_after_10_minutes() {
        let mut r = Rules::new(Settings::default());
        let dim = |t: f64| Look { brightness: 30.0, ..here(t) };
        let ev = run(&mut r, 0.0, 1300.0, dim);
        assert_eq!(ev, vec![Event::DarkTip { at: 600.0 }]);
    }

    #[test]
    fn sip_needs_two_checks_and_cools_down() {
        let mut r = Rules::new(Settings::default());
        let drink = |t: f64| Look { drink_at_hand: true, ..here(t) };
        assert!(run(&mut r, 0.0, 0.5, drink).is_empty());
        assert_eq!(run(&mut r, 0.5, 5.0, drink), vec![Event::Sip { at: 0.5 }]);
        assert!(run(&mut r, 5.0, 200.0, drink).is_empty());
        assert_eq!(run(&mut r, 300.5, 301.0, drink), vec![Event::Sip { at: 300.5 }]);
    }
}
