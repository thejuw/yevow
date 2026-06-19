"""
Committee conflict enrichment for Congressional trades.

ProPublica's Congress API is no longer available, so the runner uses the
maintained public-domain unitedstates/congress-legislators YAML files for
current committee rosters. The Worker owns ticker-sector conflict evaluation.
"""

from __future__ import annotations

import logging
import re
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import yaml

COMMITTEE_MEMBERSHIP_URL = (
    "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/"
    "committee-membership-current.yaml"
)
COMMITTEES_URL = (
    "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/"
    "committees-current.yaml"
)
LEGISLATORS_URL = (
    "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/"
    "legislators-current.yaml"
)
USER_AGENT = "Sovereign-Sigma-Congress-Runner/1.0"

RELEVANT_COMMITTEE_RE = re.compile(
    r"armed services|intelligence|homeland security|energy|natural resources|"
    r"health|aging|financial services|banking|finance|ways and means|taxation|"
    r"commerce|science|technology|agriculture|transportation|infrastructure|"
    r"judiciary|antitrust",
    re.IGNORECASE,
)


def fetch_committee_assignments(logger: logging.Logger | None = None) -> list[dict[str, Any]]:
    logger = logger or logging.getLogger(__name__)

    try:
        committees_raw, committees_updated_at = _fetch_yaml(COMMITTEES_URL)
        membership_raw, membership_updated_at = _fetch_yaml(COMMITTEE_MEMBERSHIP_URL)
    except (HTTPError, URLError, TimeoutError, OSError, yaml.YAMLError) as exc:
        logger.warning("Committee assignment fetch failed; conflict flags disabled for run: %s", exc)
        return []

    committee_names = _committee_name_map(committees_raw)
    assignments: list[dict[str, Any]] = []

    if not isinstance(membership_raw, dict):
        return assignments

    for committee_code, members in membership_raw.items():
        if not isinstance(committee_code, str) or not isinstance(members, list):
            continue

        committee_name = committee_names.get(committee_code, committee_code)
        if not RELEVANT_COMMITTEE_RE.search(committee_name):
            continue

        chamber = _committee_chamber(committee_code)

        for member in members:
            if not isinstance(member, dict):
                continue

            member_name = _clean_text(member.get("name"))
            if not member_name:
                continue

            assignments.append(
                {
                    "memberName": member_name,
                    "chamber": _clean_text(member.get("chamber")) or chamber,
                    "committeeCode": committee_code,
                    "committeeName": committee_name,
                    "committeeRole": _clean_text(member.get("title")),
                    "source": "unitedstates/congress-legislators",
                    "sourceUpdatedAt": membership_updated_at or committees_updated_at,
                }
            )

    return assignments


def fetch_member_profiles(logger: logging.Logger | None = None) -> list[dict[str, Any]]:
    logger = logger or logging.getLogger(__name__)

    try:
        legislators_raw, source_updated_at = _fetch_yaml(LEGISLATORS_URL)
    except (HTTPError, URLError, TimeoutError, OSError, yaml.YAMLError) as exc:
        logger.warning("Member profile fetch failed; bipartisan heatmap party labels disabled: %s", exc)
        return []

    profiles: list[dict[str, Any]] = []
    if not isinstance(legislators_raw, list):
        return profiles

    for legislator in legislators_raw:
        if not isinstance(legislator, dict):
            continue

        name = legislator.get("name")
        ids = legislator.get("id")
        terms = legislator.get("terms")

        if not isinstance(name, dict) or not isinstance(ids, dict) or not isinstance(terms, list):
            continue

        current_term = _current_term(terms)
        if not current_term:
            continue

        profiles.append(
            {
                "memberName": _member_display_name(name),
                "chamber": _profile_chamber(current_term.get("type")),
                "party": _clean_text(current_term.get("party")),
                "state": _clean_text(current_term.get("state")),
                "district": _district_value(current_term.get("district")),
                "bioguideId": _clean_text(ids.get("bioguide")),
                "source": "unitedstates/congress-legislators",
                "sourceUpdatedAt": source_updated_at,
            }
        )

    return [profile for profile in profiles if profile.get("memberName")]


def _fetch_yaml(url: str) -> tuple[Any, str | None]:
    request = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(request, timeout=30) as response:
        raw = response.read().decode("utf-8")
        updated_at = response.headers.get("Last-Modified")
    return yaml.safe_load(raw), updated_at


def _current_term(terms: list[Any]) -> dict[str, Any] | None:
    candidates = [term for term in terms if isinstance(term, dict)]
    if not candidates:
        return None
    return candidates[-1]


def _member_display_name(name: dict[str, Any]) -> str | None:
    official = _clean_text(name.get("official_full"))
    if official:
        return official

    parts = [
        _clean_text(name.get("first")),
        _clean_text(name.get("middle")),
        _clean_text(name.get("last")),
        _clean_text(name.get("suffix")),
    ]
    return " ".join(part for part in parts if part) or None


def _district_value(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _committee_name_map(committees_raw: Any) -> dict[str, str]:
    names: dict[str, str] = {}

    if not isinstance(committees_raw, list):
        return names

    for committee in committees_raw:
        if not isinstance(committee, dict):
            continue

        parent_code = _clean_text(committee.get("thomas_id"))
        parent_name = _clean_text(committee.get("name"))
        if not parent_code or not parent_name:
            continue

        names[parent_code] = parent_name

        subcommittees = committee.get("subcommittees")
        if not isinstance(subcommittees, list):
            continue

        for subcommittee in subcommittees:
            if not isinstance(subcommittee, dict):
                continue

            sub_code = _clean_text(subcommittee.get("thomas_id"))
            sub_name = _clean_text(subcommittee.get("name"))
            if sub_code and sub_name:
                names[f"{parent_code}{sub_code}"] = f"{parent_name} / {sub_name}"

    return names


def _committee_chamber(committee_code: str) -> str:
    if committee_code.startswith("HS"):
        return "house"
    if committee_code.startswith("SS"):
        return "senate"
    return "joint"


def _profile_chamber(value: Any) -> str:
    cleaned = _clean_text(value)
    if cleaned == "sen":
        return "senate"
    if cleaned == "rep":
        return "house"
    return cleaned or "unknown"


def _clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split()).strip()
    return cleaned or None
