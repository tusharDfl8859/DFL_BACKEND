const passwordPolicyRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]).{6,128}$/;

const validatePassword = (password) => {
    if (!password) {
        return { isValid: false, message: 'Password is required' };
    }
    if (!passwordPolicyRegex.test(password)) {
        return {
            isValid: false,
            message: 'Password must be at least 6 characters long and include an uppercase letter, a lowercase letter, a number, and a special character.'
        };
    }

    return { isValid: true, message: 'Valid password' };
};

module.exports = {
    passwordPolicyRegex,
    validatePassword
};
