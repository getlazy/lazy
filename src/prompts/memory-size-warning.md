**Memory context size:** the memory section above is over lazy's advisory size
threshold, and it is injected into every launch's prompt — so it is worth
tightening. Run `lazy doctor` for the size, the threshold, and the recommended
fix. Nothing is blocked by this.
