const buildTenantScopedQuery = ({ userId, developerAccountId, extra = {} }) => ({
    ...extra,
    userId,
    developerAccountId
});

const belongsToDeveloperTenant = (record, { userId, developerAccountId }) => {
    if (!record || !userId || !developerAccountId) {
        return false;
    }

    return (
        record.userId?.toString() === userId.toString() &&
        record.developerAccountId?.toString() === developerAccountId.toString()
    );
};

module.exports = {
    buildTenantScopedQuery,
    belongsToDeveloperTenant
};
