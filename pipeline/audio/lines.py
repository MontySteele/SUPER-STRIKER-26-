# -*- coding: utf-8 -*-
"""The commentary script for SUPER STRIKER '26.
#
# This is the single source of truth for what the commentators SAY. The runtime
# (src/audio/commentary.ts) only knows GROUP NAMES and which slots it can fill;
# every word, every variant and every splice point lives here and travels to the
# game inside public/audio/commentary.json.
#
# A template is a plain string with {slot} placeholders. The baker splits it at
# the placeholders and renders each text run as its own clip, so a line can be
# spliced back together at runtime around a player surname or a team name:
#
#     "What a finish from {scorer}!"
#       -> clip "What a finish from" + name clip "Okafor!"
#
# Rules of thumb that keep splices from sounding like a train announcement:
#   * at most two slots per line, and prefer the slot at the END of the line;
#   * never leave a text run that is only punctuation (the baker drops those);
#   * a run that follows a slot should be a real phrase ("finds the corner!"),
#     not a stray word.
#
# Slots the runtime can fill: scorer, keeper, shooter, player, taker, team,
# home, away, winner, num_home, num_away.
"""

PBP = "pbp"      # play-by-play (bm_george)
COL = "colour"   # colour/summariser (bm_lewis)

# Priority is decided by the runtime director (commentaryScript.ts); the value
# here is advisory and is copied into the manifest for the dry-run log.
#   3 = goals & verdicts (interrupts anything)
#   2 = drama (cards, penalties, half/full-time whistles)
#   1 = chances (saves, posts, misses, bookings)
#   0 = colour & restarts (only ever heard in a quiet spell)

GROUPS: dict[str, dict] = {

    # ---------------------------------------------------------------- kickoff
    "kickoff.match": {"voice": PBP, "cat": "kickoff", "pri": 2, "lines": [
        "And we are under way!",
        "The referee's whistle — and we're off!",
        "Here we go, then. Kick off.",
        "{home} against {away} — here we go!",
        "A full house, a big night, and we are under way!",
    ]},
    "kickoff.golden": {"voice": PBP, "cat": "kickoff", "pri": 2, "lines": [
        "Golden goal. The next one wins it.",
        "Sudden death now. One goal ends it.",
    ]},
    "kickoff.second": {"voice": PBP, "cat": "kickoff", "pri": 1, "lines": [
        "Second half under way.",
        "Back out for the second half.",
        "Forty-five more minutes. Off we go again.",
    ]},
    "kickoff.extra": {"voice": PBP, "cat": "kickoff", "pri": 2, "lines": [
        "Extra time. Thirty more minutes to settle it.",
        "We go to extra time, and legs are already heavy.",
    ]},

    # ------------------------------------------------------------------- goal
    "goal.generic": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "GOAL! What a finish from {scorer}!",
        "It's in! {scorer}!",
        "Oh, that is beautiful! {scorer} with the finish!",
        "He's done it! {scorer}!",
        "GOAL! Take a bow, {scorer}!",
        "That is a wonderful goal! {scorer}!",
        "The net bulges! {scorer} has scored!",
        "Buried it! No chance for the keeper. {scorer}!",
    ]},
    "goal.team": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "GOAL for {team}! {scorer} finds the corner!",
        "A goal for {team}! It's {scorer}!",
    ]},
    "goal.opener": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "And the deadlock is broken! {scorer}!",
        "First blood! {scorer} breaks the deadlock!",
        "There it is — the opening goal, and it belongs to {scorer}!",
    ]},
    "goal.equaliser": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "It's level! {scorer} has the equaliser!",
        "All square again! Up pops {scorer}!",
        "They're back in it! What a moment for {scorer}!",
    ]},
    "goal.lead": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "That's the lead! {scorer} puts them in front!",
        "In front for the first time! {scorer}!",
        "They've turned it around! {scorer} with the goal!",
    ]},
    "goal.late": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "Surely that's the winner! {scorer}, and the clock is against them!",
        "Late, late drama! {scorer}!",
        "Oh, what a time to score! {scorer}!",
    ]},
    "goal.own": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "Oh no — it's an own goal! {scorer} has turned it into his own net!",
        "Disaster! Into his own goal — {scorer}!",
        "He'll never want to see that again. An own goal from {scorer}!",
    ]},

    # ----------------------------------------------------------------- chance
    "save.big": {"voice": PBP, "cat": "chance", "pri": 1, "lines": [
        "What a save from {keeper}!",
        "Denied! {keeper} says no!",
        "Brilliant goalkeeping. {keeper}!",
        "Somehow he's kept that out! {keeper}!",
        "A strong hand from {keeper}!",
    ]},
    "post.hit": {"voice": PBP, "cat": "chance", "pri": 1, "lines": [
        "Off the woodwork!",
        "The post! Inches away.",
        "He's hit the frame of the goal!",
        "Off the upright, and away to safety!",
    ]},
    "miss.wide": {"voice": PBP, "cat": "chance", "pri": 1, "lines": [
        "Wide! He'll want that one back — {shooter}.",
        "Just off target from {shooter}.",
        "Over the bar. A big chance gone for {shooter}.",
        "Dragged wide by {shooter}.",
    ]},
    "shot.effort": {"voice": PBP, "cat": "chance", "pri": 1, "lines": [
        "Good effort!",
        "He's tested the keeper there.",
        "Worth a try from distance.",
        "That's asking a question of the goalkeeper.",
    ]},

    # ---------------------------------------------------------------- restart
    "corner.won": {"voice": PBP, "cat": "restart", "pri": 0, "lines": [
        "Corner.",
        "That's a corner kick.",
        "It's gone behind. Corner.",
        "A chance to load the box — corner to {team}.",
    ]},
    "offside.flag": {"voice": PBP, "cat": "restart", "pri": 1, "lines": [
        "Flag's up. Offside.",
        "Offside. He went too early — {player}.",
        "The linesman's flag ends that one.",
    ]},
    "foul.given": {"voice": PBP, "cat": "restart", "pri": 0, "lines": [
        "Free kick. That's a foul by {player}.",
        "The referee blows. Foul.",
        "He's pulled that one up.",
        "Clumsy, that, from {player}.",
    ]},

    # ------------------------------------------------------------- discipline
    "card.yellow": {"voice": PBP, "cat": "discipline", "pri": 1, "lines": [
        "Yellow card. Into the book goes {player}.",
        "That's a booking for {player}.",
        "The referee reaches for his pocket. Yellow for {player}.",
    ]},
    "card.red": {"voice": PBP, "cat": "discipline", "pri": 2, "lines": [
        "Red card! He's off! {player}!",
        "He's sending him off! A long walk for {player}!",
        "That is a red card, and they are down to ten men!",
    ]},

    # ---------------------------------------------------------------- penalty
    "pen.awarded": {"voice": PBP, "cat": "penalty", "pri": 2, "lines": [
        "Penalty! The referee points to the spot!",
        "He's given it! A penalty kick!",
        "It's a penalty to {team}! Huge moment, this.",
    ]},
    "pen.scored": {"voice": PBP, "cat": "penalty", "pri": 2, "lines": [
        "Buried it! {taker}!",
        "Scored! Ice cold from {taker}.",
        "He's made no mistake from twelve yards.",
    ]},
    "pen.saved": {"voice": PBP, "cat": "penalty", "pri": 2, "lines": [
        "Saved! The keeper goes the right way!",
        "He's saved it! What a moment!",
        "Kept out! Unbelievable scenes!",
    ]},
    "pen.missed": {"voice": PBP, "cat": "penalty", "pri": 2, "lines": [
        "He's missed it! Wide of the post — {taker}!",
        "Over the bar! An awful penalty from {taker}!",
    ]},
    "shootout.win": {"voice": PBP, "cat": "penalty", "pri": 3, "lines": [
        "And it's {team} who go through!",
        "The shootout is won! Congratulations, {team}!",
    ]},
    "pen.tension": {"voice": COL, "cat": "colour", "pri": 1, "lines": [
        "You could hear a pin drop in here.",
        "This is the loneliest walk in football.",
    ]},

    # ---------------------------------------------------------------- verdict
    "break.halftime": {"voice": PBP, "cat": "verdict", "pri": 2, "lines": [
        "That's half time.",
        "The whistle goes for the interval.",
        "Forty-five gone, and the referee calls a halt.",
    ]},
    "break.penalties": {"voice": PBP, "cat": "verdict", "pri": 2, "lines": [
        "We are going to penalties.",
        "Nothing between them. It goes to the spot.",
    ]},
    "break.extratime": {"voice": PBP, "cat": "verdict", "pri": 2, "lines": [
        "We need extra time to settle this.",
        "Level at the end of ninety. There's more to come.",
    ]},
    "fulltime.win": {"voice": PBP, "cat": "verdict", "pri": 3, "lines": [
        "There's the final whistle! The win goes to {team}!",
        "It's all over! A famous night for {team}!",
        "Full time. {team} have done it!",
    ]},
    "fulltime.draw": {"voice": PBP, "cat": "verdict", "pri": 3, "lines": [
        "There's the final whistle, and honours are even.",
        "Full time, and neither side could be separated.",
    ]},
    "score.report": {"voice": PBP, "cat": "verdict", "pri": 1, "lines": [
        "The score: {home} {num_home}, {away} {num_away}.",
        "It stands at {home} {num_home}, {away} {num_away}.",
    ]},

    # --------------------------------------------------------------- build-up
    "buildup.danger": {"voice": PBP, "cat": "buildup", "pri": 1, "lines": [
        "This looks dangerous!",
        "They're in behind!",
        "Here's a chance!",
        "Ooh, this is promising!",
        "The box is filling up!",
    ]},
    "buildup.attack": {"voice": PBP, "cat": "buildup", "pri": 0, "lines": [
        "{team} pushing forward.",
        "They're building again.",
        "Patient stuff here.",
        "Working it wide, looking for a way in.",
    ]},

    # ------------------------------------------------------------- fallbacks
    # Every line above that ALWAYS needs a name is paired with a slot-free
    # group here (see FALLBACK). A name the bake never saw — a roster edit, a
    # spelling with an accent stripped — must cost a flavour, never the call.
    "goal.plain": {"voice": PBP, "cat": "goal", "pri": 3, "lines": [
        "GOAL! Oh, that is a wonderful strike!",
        "It's in! The net bulges, and this place erupts!",
        "GOAL! They've got it! What a moment!",
        "He's buried it! No chance whatsoever for the keeper!",
    ]},
    "save.plain": {"voice": PBP, "cat": "chance", "pri": 1, "lines": [
        "What a save!",
        "Denied! Brilliant goalkeeping!",
        "He's kept that out somehow!",
    ]},
    "miss.plain": {"voice": PBP, "cat": "chance", "pri": 1, "lines": [
        "Wide! He'll want that one back.",
        "Just off target.",
        "Over the bar. A big chance gone.",
    ]},
    "card.yellow.plain": {"voice": PBP, "cat": "discipline", "pri": 1, "lines": [
        "Yellow card. That goes in the book.",
        "The referee reaches for his pocket. It's a booking.",
    ]},
    "card.red.plain": {"voice": PBP, "cat": "discipline", "pri": 2, "lines": [
        "Red card! He's off!",
        "He's sending him off! They are down to ten men!",
    ]},
    "pen.plain.scored": {"voice": PBP, "cat": "penalty", "pri": 2, "lines": [
        "Buried it! Ice cold from twelve yards.",
        "Scored! He's made no mistake.",
    ]},
    "pen.plain.missed": {"voice": PBP, "cat": "penalty", "pri": 2, "lines": [
        "He's missed it! Wide of the post!",
        "Over the bar! An awful penalty!",
    ]},
    "fulltime.plain": {"voice": PBP, "cat": "verdict", "pri": 3, "lines": [
        "There's the final whistle! It's all over!",
        "Full time! And what a night it has been!",
    ]},
    "kickoff.plain": {"voice": PBP, "cat": "kickoff", "pri": 2, "lines": [
        "And we are under way!",
        "Here we go, then. Kick off.",
    ]},
    "offside.plain": {"voice": PBP, "cat": "restart", "pri": 1, "lines": [
        "Flag's up. Offside.",
        "The linesman's flag ends that one.",
    ]},
    "foul.plain": {"voice": PBP, "cat": "restart", "pri": 0, "lines": [
        "The referee blows. Foul.",
        "He's pulled that one up.",
    ]},

    # ----------------------------------------------------------------- colour
    "colour.general": {"voice": COL, "cat": "colour", "pri": 0, "lines": [
        "The tempo has dropped a touch here.",
        "You can feel the belief growing in this crowd.",
        "That's the kind of pass that wins you matches.",
        "The back line is sitting deeper now — they're protecting what they have.",
        "Plenty of running still in these legs.",
        "This has been a proper contest.",
        "They can't afford to give the ball away in that area.",
        "Lovely touch. That's why he's in the side.",
        "The manager is up off his bench again.",
        "A yard of space is all he needs.",
        "Good support from midfield there.",
        "It's been a scrappy few minutes, this.",
        "Somebody needs to take responsibility here.",
        "The keeper's been the busier of the two, no question.",
    ]},
    "colour.after_goal": {"voice": COL, "cat": "colour", "pri": 1, "lines": [
        "Well, that changes everything.",
        "You have to say, the finish was the easy part.",
        "Watch the movement before the ball arrives — that's what does it.",
        "Sloppy marking. He was left completely alone.",
    ]},
    "colour.after_card": {"voice": COL, "cat": "colour", "pri": 1, "lines": [
        "He knew what he was doing there.",
        "Harsh, that. He got a touch on the ball.",
        "He'll have to be careful for the rest of the night.",
    ]},
    "colour.after_miss": {"voice": COL, "cat": "colour", "pri": 1, "lines": [
        "At this level you have to score those.",
        "He had all the time in the world, and he rushed it.",
        "The keeper never moved. That's a gift refused.",
    ]},
}

# When no variant of a group can be voiced — an unbaked surname, a team not in
# the pack — the runtime takes one hop to this slot-free stand-in rather than
# swallowing the moment. Groups absent from this map simply go unsaid.
FALLBACK: dict[str, str] = {
    "goal.generic": "goal.plain",
    "goal.team": "goal.plain",
    "goal.opener": "goal.plain",
    "goal.equaliser": "goal.plain",
    "goal.lead": "goal.plain",
    "goal.late": "goal.plain",
    "goal.own": "goal.plain",
    "save.big": "save.plain",
    "miss.wide": "miss.plain",
    "card.yellow": "card.yellow.plain",
    "card.red": "card.red.plain",
    "pen.scored": "pen.plain.scored",
    "pen.missed": "pen.plain.missed",
    "fulltime.win": "fulltime.plain",
    "fulltime.draw": "fulltime.plain",
    "shootout.win": "fulltime.plain",
    "kickoff.match": "kickoff.plain",
    "offside.flag": "offside.plain",
    "foul.given": "foul.plain",
    "corner.won": "corner.won",
    "pen.awarded": "pen.awarded",
    "buildup.attack": "buildup.attack",
}

# Numbers for the scoreline read-out. 0 is "nil" in a football score.
NUMBERS = ["nil", "one", "two", "three", "four", "five", "six",
           "seven", "eight", "nine", "ten"]

# Name clips carry their own energy so a goal call doesn't die on the surname.
NAME_TEMPLATE = "{name}!"
TEAM_TEMPLATE = "{name}"
