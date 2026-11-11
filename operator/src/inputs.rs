#[derive(Clone, Copy, Debug, PartialEq)]
pub enum InputType {
    Boolean,
    Scalar,
    Vector2,
}
#[derive(Clone, Debug)]
pub enum Value {
    Boolean {
        value: bool,
        presses: u64,
        releases: u64,
    },
    Scalar(f32),
    Vector2([f32; 2]),
}
#[derive(Clone, Debug)]
pub struct Input {
    pub active: bool,
    pub changed_at: Option<i64>,
    pub value: Value,
}
#[derive(Clone, Copy)]
pub struct Definition {
    pub source: &'static str,
    pub id: &'static str,
    pub path: &'static str,
    pub kind: InputType,
    pub label: &'static str,
}

pub fn definitions() -> &'static [Definition] {
    static DEFINITIONS: std::sync::LazyLock<Vec<Definition>> = std::sync::LazyLock::new(|| {
        let mut result = Vec::new();
        for source in ["left", "right"] {
            for (id, path, kind, label) in [
                (
                    "primary/click",
                    if source == "left" {
                        "x/click"
                    } else {
                        "a/click"
                    },
                    InputType::Boolean,
                    if source == "left" { "X" } else { "A" },
                ),
                (
                    "primary/touch",
                    if source == "left" {
                        "x/touch"
                    } else {
                        "a/touch"
                    },
                    InputType::Boolean,
                    "Primary touch",
                ),
                (
                    "secondary/click",
                    if source == "left" {
                        "y/click"
                    } else {
                        "b/click"
                    },
                    InputType::Boolean,
                    if source == "left" { "Y" } else { "B" },
                ),
                (
                    "secondary/touch",
                    if source == "left" {
                        "y/touch"
                    } else {
                        "b/touch"
                    },
                    InputType::Boolean,
                    "Secondary touch",
                ),
                (
                    "squeeze/click",
                    "squeeze/value",
                    InputType::Boolean,
                    "Grip pressed",
                ),
                ("squeeze/value", "squeeze/value", InputType::Scalar, "Grip"),
                (
                    "thumbrest/touch",
                    "thumbrest/touch",
                    InputType::Boolean,
                    "Thumbrest touch",
                ),
                (
                    "thumbstick/click",
                    "thumbstick/click",
                    InputType::Boolean,
                    "Stick click",
                ),
                (
                    "thumbstick/touch",
                    "thumbstick/touch",
                    InputType::Boolean,
                    "Stick touch",
                ),
                (
                    "thumbstick/value",
                    "thumbstick",
                    InputType::Vector2,
                    "Stick",
                ),
                (
                    "trigger/click",
                    "trigger/value",
                    InputType::Boolean,
                    "Trigger pressed",
                ),
                (
                    "trigger/touch",
                    "trigger/touch",
                    InputType::Boolean,
                    "Trigger touch",
                ),
                (
                    "trigger/value",
                    "trigger/value",
                    InputType::Scalar,
                    "Trigger",
                ),
            ] {
                result.push(Definition {
                    source,
                    id,
                    path,
                    kind,
                    label,
                });
            }
            if source == "left" {
                result.push(Definition {
                    source,
                    id: "menu/click",
                    path: "menu/click",
                    kind: InputType::Boolean,
                    label: "Menu",
                });
            }
        }
        result.sort_by_key(|d| (d.source, d.id));
        result
    });
    &DEFINITIONS
}
impl Input {
    pub fn inactive(kind: InputType) -> Self {
        Self {
            active: false,
            changed_at: None,
            value: match kind {
                InputType::Boolean => Value::Boolean {
                    value: false,
                    presses: 0,
                    releases: 0,
                },
                InputType::Scalar => Value::Scalar(0.),
                InputType::Vector2 => Value::Vector2([0.; 2]),
            },
        }
    }
    pub fn count_from(&mut self, previous: &Self) {
        if let (
            Value::Boolean {
                value,
                presses,
                releases,
            },
            Value::Boolean {
                value: old,
                presses: old_presses,
                releases: old_releases,
            },
        ) = (&mut self.value, &previous.value)
        {
            *presses = *old_presses;
            *releases = *old_releases;
            if self.active && previous.active && value != old {
                if *value {
                    *presses = presses.checked_add(1).expect("Press counter exhausted");
                } else {
                    *releases = releases.checked_add(1).expect("Release counter exhausted");
                }
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn transitions_count_during_acquisition_and_reactivation_only_rebaselines() {
        let mut previous = Input::inactive(InputType::Boolean);
        for (active, value, expected) in [
            (true, true, (0, 0)),
            (true, false, (0, 1)),
            (true, true, (1, 1)),
            (false, false, (1, 1)),
            (true, false, (1, 1)),
            (true, true, (2, 1)),
        ] {
            let mut input = Input {
                active,
                changed_at: None,
                value: Value::Boolean {
                    value,
                    presses: 0,
                    releases: 0,
                },
            };
            input.count_from(&previous);
            if let Value::Boolean {
                presses, releases, ..
            } = input.value
            {
                assert_eq!((presses, releases), expected);
            }
            previous = input;
        }
    }
}
