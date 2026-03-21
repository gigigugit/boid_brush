/* tslint:disable */
/* eslint-disable */
export const memory: WebAssembly.Memory;
export const get_agent_buffer_ptr: () => number;
export const get_params_buffer_ptr: () => number;
export const get_params_len: () => number;
export const get_pigment_ptr: () => number;
export const get_sensing_buffer_ptr: () => number;
export const get_stride: () => number;
export const init_sensing: (a: number, b: number) => void;
export const lbm_init: (a: number, b: number) => void;
export const remove_agent: (a: number) => void;
export const sim_init: (a: number, b: number, c: number) => void;
export const spawn_batch: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => void;
export const update_sensing: () => void;
export const step: (a: number) => void;
export const get_agent_count: () => number;
export const clear_agents: () => void;
export const lbm_reset: () => void;
export const get_lbm_height: () => number;
export const get_lbm_width: () => number;
export const spawn_agent: (a: number, b: number) => number;
export const step_lbm: () => void;
export const set_params: () => void;
