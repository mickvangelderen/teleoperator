use crate::inputs::{Definition, Input, InputType, Value};
use openxr as xr;

pub enum Action {
    Boolean(xr::Action<bool>),
    Scalar(xr::Action<f32>),
    Vector2(xr::Action<xr::Vector2f>),
}
impl Action {
    pub fn create(set: &xr::ActionSet, definition: &Definition, index: usize) -> xr::Result<Self> {
        let name = format!("input_{index}");
        let label = format!("{} {}", definition.source, definition.label);
        Ok(match definition.kind {
            InputType::Boolean => Self::Boolean(set.create_action(&name, &label, &[])?),
            InputType::Scalar => Self::Scalar(set.create_action(&name, &label, &[])?),
            InputType::Vector2 => Self::Vector2(set.create_action(&name, &label, &[])?),
        })
    }
    pub fn binding(&self, path: xr::Path) -> xr::Binding<'_> {
        match self {
            Self::Boolean(a) => xr::Binding::new(a, path),
            Self::Scalar(a) => xr::Binding::new(a, path),
            Self::Vector2(a) => xr::Binding::new(a, path),
        }
    }
    pub fn sample(&self, session: &xr::Session<xr::OpenGlEs>, synchronized: bool) -> Input {
        // shortcut: omit runtime change times until their server-epoch conversion is validated on Quest.
        match self {
            Self::Boolean(action) => action
                .state(session, xr::Path::NULL)
                .map(|s| Input {
                    active: synchronized && s.is_active,
                    changed_at: None,
                    value: Value::Boolean {
                        value: s.current_state,
                        presses: 0,
                        releases: 0,
                    },
                })
                .unwrap_or_else(|_| Input::inactive(InputType::Boolean)),
            Self::Scalar(action) => action
                .state(session, xr::Path::NULL)
                .map(|s| Input {
                    active: synchronized && s.is_active && s.current_state.is_finite(),
                    changed_at: None,
                    value: Value::Scalar(s.current_state),
                })
                .unwrap_or_else(|_| Input::inactive(InputType::Scalar)),
            Self::Vector2(action) => action
                .state(session, xr::Path::NULL)
                .map(|s| Input {
                    active: synchronized
                        && s.is_active
                        && s.current_state.x.is_finite()
                        && s.current_state.y.is_finite(),
                    changed_at: None,
                    value: Value::Vector2([s.current_state.x, s.current_state.y]),
                })
                .unwrap_or_else(|_| Input::inactive(InputType::Vector2)),
        }
    }
}
