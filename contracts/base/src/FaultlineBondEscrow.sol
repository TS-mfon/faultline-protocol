// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

interface IERC20Balance {
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @notice Fixed-term USDC bonds. A trusted EOA attests successful, finalized GenLayer judgments.
/// @dev No upgrade, admin sweep, term edits, or attestor rotation. All times are exclusive deadlines.
contract FaultlineBondEscrow {
    uint256 public constant LOCK_DURATION = 7 days;
    uint256 public constant REPAIR_WINDOW = 48 hours;
    uint256 public constant MAX_AMOUNT = 10 ** 24 - 1;
    uint8 public constant ACTIVATION_PHASE = 1;
    uint8 public constant RESERVATION_PHASE = 2;
    uint8 public constant RELEASE_PHASE = 3;
    bytes32 public constant ACTIVATION_TYPEHASH = keccak256(
        "ActivationAuthorization(bytes32 workflowId,bytes32 workflowHash,bytes32 termsHash,uint256 genlayerChainId,address genlayerContract,bytes32 caseId,bytes32 snapshotHash,bytes32 decisionId,uint8 phase,uint256 nonce,uint256 expiry)"
    );
    bytes32 public constant RESERVATION_TYPEHASH = keccak256(
        "ReservationAuthorization(bytes32 workflowId,bytes32 workflowHash,bytes32 termsHash,uint256 genlayerChainId,address genlayerContract,bytes32 caseId,bytes32 snapshotHash,bytes32 decisionId,uint8 phase,uint256 nonce,uint256 expiry,bytes32 remedyId,bytes32 classesHash)"
    );
    bytes32 public constant RELEASE_TYPEHASH = keccak256(
        "ReleaseAuthorization(bytes32 workflowId,bytes32 workflowHash,bytes32 termsHash,uint256 genlayerChainId,address genlayerContract,bytes32 caseId,bytes32 snapshotHash,bytes32 decisionId,uint8 phase,uint256 nonce,uint256 expiry,bytes32 remedyId,bytes32 reservationDecisionId,bytes32 reservationSnapshotHash,bytes32 repairHash)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    enum State {
        Missing,
        Funding,
        Active,
        CaseOpen,
        Reserved,
        Released,
        Expired
    }

    struct RepairAction {
        bytes32 id;
        address recipient;
        uint256 price;
    }

    struct ActivationAuthorization {
        bytes32 workflowId;
        bytes32 workflowHash;
        bytes32 termsHash;
        uint256 genlayerChainId;
        address genlayerContract;
        bytes32 caseId;
        bytes32 snapshotHash;
        bytes32 decisionId;
        uint8 phase;
        uint256 nonce;
        uint256 expiry;
    }

    struct ReservationAuthorization {
        bytes32 workflowId;
        bytes32 workflowHash;
        bytes32 termsHash;
        uint256 genlayerChainId;
        address genlayerContract;
        bytes32 caseId;
        bytes32 snapshotHash;
        bytes32 decisionId;
        uint8 phase;
        uint256 nonce;
        uint256 expiry;
        bytes32 remedyId;
        bytes32 classesHash;
    }

    struct ReleaseAuthorization {
        bytes32 workflowId;
        bytes32 workflowHash;
        bytes32 termsHash;
        uint256 genlayerChainId;
        address genlayerContract;
        bytes32 caseId;
        bytes32 snapshotHash;
        bytes32 decisionId;
        uint8 phase;
        uint256 nonce;
        uint256 expiry;
        bytes32 remedyId;
        bytes32 reservationDecisionId;
        bytes32 reservationSnapshotHash;
        bytes32 repairHash;
    }

    struct Workflow {
        State state;
        bytes32 workflowHash;
        bytes32 termsHash;
        uint256 genlayerChainId;
        address genlayerContract;
        uint256 repairCap;
        uint256 hardDeadline;
        uint256 repairDeadline;
        uint256 nextNonce;
        uint256 fundedCount;
        bytes32 caseId;
        bytes32 activationDecisionId;
        bytes32 activationSnapshotHash;
        bytes32 repairDecisionId;
        bytes32 repairSnapshotHash;
        bytes32 repairHash;
        bytes32 reservationDecisionId;
        bytes32 reservationSnapshotHash;
        bytes32 remedyId;
        uint256 reserved;
    }

    address public immutable USDC;
    address public immutable attestor;
    address public immutable guardian;
    bool public paused;
    uint256 public totalLiability;
    uint256 private entered = 1;
    mapping(bytes32 => Workflow) private workflows;
    mapping(bytes32 => address[]) private agentsByWorkflow;
    mapping(bytes32 => bytes32[]) private nodesByWorkflow;
    mapping(bytes32 => uint8[]) private nodeAgentsByWorkflow;
    mapping(bytes32 => RepairAction[]) private repairsByWorkflow;
    mapping(bytes32 => mapping(address => uint256)) public bondCap;
    mapping(bytes32 => mapping(address => uint256)) public originalDeposit;
    /// @notice Locked until Released/Expired; includes recipient credit after successful release.
    mapping(bytes32 => mapping(address => uint256)) public balance;
    mapping(bytes32 => mapping(address => uint256)) public reservedDebit;

    error InvalidTerms();
    error WrongState();
    error Unauthorized();
    error Paused();
    error DeadlinePassed();
    error NotMature();
    error InvalidAuthorization();
    error InvalidSignature();
    error InvalidClasses();
    error LiableRepairer();
    error TransferFailed();
    error InexactTransfer();
    error Reentrancy();
    error NothingToWithdraw();

    event WorkflowCreated(
        bytes32 indexed workflowId, bytes32 indexed workflowHash, bytes32 termsHash, uint256 hardDeadline
    );
    event BondDeposited(bytes32 indexed workflowId, address indexed agent, uint256 amount);
    event WorkflowActivated(bytes32 indexed workflowId, bytes32 indexed decisionId);
    event CaseOpened(bytes32 indexed workflowId, bytes32 indexed caseId, address indexed reporter);
    event AwardReserved(
        bytes32 indexed workflowId,
        bytes32 indexed remedyId,
        bytes32 decisionId,
        bytes32 snapshotHash,
        uint256 amount,
        uint256 deadline
    );
    event RepairReleased(
        bytes32 indexed workflowId, bytes32 indexed decisionId, bytes32 repairHash, address recipient, uint256 amount
    );
    event WorkflowExpired(bytes32 indexed workflowId);
    event Withdrawn(bytes32 indexed workflowId, address indexed beneficiary, uint256 amount);
    event PauseChanged(bool paused);

    modifier nonReentrant() {
        if (entered != 1) {
            revert Reentrancy();
        }
        entered = 2;
        _;
        entered = 1;
    }
    modifier whenNotPaused() {
        if (paused) {
            revert Paused();
        }
        _;
    }

    constructor(address usdc_, address attestor_, address guardian_) {
        if (usdc_.code.length == 0 || attestor_ == address(0) || attestor_.code.length != 0 || guardian_ == address(0))
        {
            revert InvalidTerms();
        }
        if (IERC20Balance(usdc_).decimals() != 6) {
            revert InvalidTerms();
        }
        USDC = usdc_;
        attestor = attestor_;
        guardian = guardian_;
    }

    /// @dev agents are strictly ascending. nodeAgents[i] indexes agents for nodeIds[i].
    /// Creation is permissionless; funders and the attestor must compare EVERY term to the accepted manifest.
    function createWorkflow(
        bytes32 workflowId,
        bytes32 workflowHash,
        address[] calldata agents,
        uint256[] calldata caps,
        uint256 repairCap,
        RepairAction[] calldata repairs,
        bytes32[] calldata nodeIds,
        uint8[] calldata nodeAgents,
        uint256 genlayerChainId,
        address genlayerContract
    ) external nonReentrant whenNotPaused {
        if (workflowId == 0 || workflowHash == 0 || workflows[workflowId].state != State.Missing) {
            revert InvalidTerms();
        }
        if (
            agents.length == 0 || agents.length > 8 || agents.length != caps.length || repairCap == 0
                || repairCap > MAX_AMOUNT
        ) {
            revert InvalidTerms();
        }
        if (
            nodeIds.length == 0 || nodeIds.length > 8 || nodeIds.length != nodeAgents.length || repairs.length == 0
                || repairs.length > 8
        ) {
            revert InvalidTerms();
        }
        if (genlayerChainId == 0 || genlayerContract == address(0)) {
            revert InvalidTerms();
        }
        uint256 seenAgents;
        for (uint256 i; i < agents.length; ++i) {
            if (
                agents[i] == address(0) || agents[i] == address(this) || agents[i].code.length != 0
                    || (i > 0 && agents[i - 1] >= agents[i])
            ) {
                revert InvalidTerms();
            }
            if (caps[i] < repairCap || caps[i] > MAX_AMOUNT) {
                revert InvalidTerms();
            }
            bondCap[workflowId][agents[i]] = caps[i];
        }
        for (uint256 i; i < nodeIds.length; ++i) {
            if (nodeIds[i] == 0 || nodeAgents[i] >= agents.length) {
                revert InvalidTerms();
            }
            for (uint256 j; j < i; ++j) {
                if (nodeIds[i] == nodeIds[j]) {
                    revert InvalidTerms();
                }
            }
            seenAgents |= uint256(1) << nodeAgents[i];
        }
        if (seenAgents != (uint256(1) << agents.length) - 1) {
            revert InvalidTerms();
        }
        for (uint256 i; i < repairs.length; ++i) {
            RepairAction calldata r = repairs[i];
            if (
                r.id == 0 || r.recipient == address(0) || r.recipient == address(this) || r.price == 0
                    || r.price > repairCap
            ) {
                revert InvalidTerms();
            }
            for (uint256 j; j < i; ++j) {
                if (r.id == repairs[j].id) {
                    revert InvalidTerms();
                }
            }
            repairsByWorkflow[workflowId].push(r);
        }
        Workflow storage w = workflows[workflowId];
        w.state = State.Funding;
        w.workflowHash = workflowHash;
        w.genlayerChainId = genlayerChainId;
        w.genlayerContract = genlayerContract;
        w.repairCap = repairCap;
        w.hardDeadline = block.timestamp + LOCK_DURATION;
        w.termsHash = keccak256(
            abi.encode(
                workflowId,
                workflowHash,
                agents,
                caps,
                repairCap,
                repairs,
                nodeIds,
                nodeAgents,
                genlayerChainId,
                genlayerContract
            )
        );
        agentsByWorkflow[workflowId] = agents;
        nodesByWorkflow[workflowId] = nodeIds;
        nodeAgentsByWorkflow[workflowId] = nodeAgents;
        emit WorkflowCreated(workflowId, workflowHash, w.termsHash, w.hardDeadline);
    }

    function depositBond(bytes32 workflowId) external nonReentrant whenNotPaused {
        Workflow storage w = workflows[workflowId];
        _live(w, State.Funding);
        uint256 amount = bondCap[workflowId][msg.sender];
        if (amount == 0 || originalDeposit[workflowId][msg.sender] != 0) {
            revert Unauthorized();
        }
        originalDeposit[workflowId][msg.sender] = amount;
        balance[workflowId][msg.sender] = amount;
        ++w.fundedCount;
        totalLiability += amount;
        _transferExact(msg.sender, address(this), amount);
        emit BondDeposited(workflowId, msg.sender, amount);
    }

    function activateWorkflow(ActivationAuthorization calldata a, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        Workflow storage w = workflows[a.workflowId];
        _live(w, State.Funding);
        _binding(w, a.workflowHash, a.termsHash, a.genlayerChainId, a.genlayerContract, a.nonce, a.expiry);
        if (
            a.phase != ACTIVATION_PHASE || a.caseId != 0 || a.snapshotHash == 0 || a.decisionId == 0
                || w.fundedCount != agentsByWorkflow[a.workflowId].length
        ) {
            revert InvalidAuthorization();
        }
        _signature(hashActivation(a), signature);
        ++w.nextNonce;
        w.activationDecisionId = a.decisionId;
        w.activationSnapshotHash = a.snapshotHash;
        w.state = State.Active;
        emit WorkflowActivated(a.workflowId, a.decisionId);
    }

    function openCase(bytes32 workflowId, bytes32 caseId) external nonReentrant whenNotPaused {
        Workflow storage w = workflows[workflowId];
        _live(w, State.Active);
        if (bondCap[workflowId][msg.sender] == 0 && msg.sender != attestor) {
            revert Unauthorized();
        }
        if (caseId == 0) {
            revert InvalidTerms();
        }
        w.caseId = caseId;
        w.state = State.CaseOpen;
        emit CaseOpened(workflowId, caseId, msg.sender);
    }

    /// @notice classes[i] is the finding for frozen node i; 0 means absent, 1 primary, 2 contributory,
    /// 3 downstream consequence, 4 excused. 5 unresolved ALWAYS prevents reservation.
    function reserveAward(ReservationAuthorization calldata a, uint8[] calldata classes, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        Workflow storage w = workflows[a.workflowId];
        _live(w, State.CaseOpen);
        _binding(w, a.workflowHash, a.termsHash, a.genlayerChainId, a.genlayerContract, a.nonce, a.expiry);
        if (
            a.phase != RESERVATION_PHASE || a.caseId != w.caseId || a.snapshotHash == 0 || a.decisionId == 0
                || a.decisionId == w.activationDecisionId || a.classesHash != keccak256(abi.encode(classes))
        ) {
            revert InvalidAuthorization();
        }
        _signature(hashReservation(a), signature);
        RepairAction memory r = _repair(a.workflowId, a.remedyId);
        _reserveDebits(a.workflowId, classes, r);
        ++w.nextNonce;
        w.reserved = r.price;
        w.remedyId = r.id;
        w.reservationDecisionId = a.decisionId;
        w.reservationSnapshotHash = a.snapshotHash;
        uint256 deadline = block.timestamp + REPAIR_WINDOW;
        w.repairDeadline = deadline < w.hardDeadline ? deadline : w.hardDeadline;
        w.state = State.Reserved;
        emit AwardReserved(a.workflowId, r.id, a.decisionId, a.snapshotHash, r.price, w.repairDeadline);
    }

    /// @notice Only a separately finalized, successful repair judgment may authorize this phase.
    /// Release creates a fixed-recipient credit; anyone can then call withdrawFor.
    function releaseRepair(ReleaseAuthorization calldata a, bytes calldata signature)
        external
        nonReentrant
        whenNotPaused
    {
        Workflow storage w = workflows[a.workflowId];
        _live(w, State.Reserved);
        _binding(w, a.workflowHash, a.termsHash, a.genlayerChainId, a.genlayerContract, a.nonce, a.expiry);
        if (block.timestamp >= w.repairDeadline) {
            revert DeadlinePassed();
        }
        if (
            a.phase != RELEASE_PHASE || a.caseId != w.caseId || a.snapshotHash == 0 || a.decisionId == 0
                || a.repairHash == 0 || a.decisionId == w.reservationDecisionId
                || a.decisionId == w.activationDecisionId || a.remedyId != w.remedyId
                || a.reservationDecisionId != w.reservationDecisionId
                || a.reservationSnapshotHash != w.reservationSnapshotHash
        ) {
            revert InvalidAuthorization();
        }
        _signature(hashRelease(a), signature);
        RepairAction memory r = _repair(a.workflowId, w.remedyId);
        uint256 amount = w.reserved;
        w.reserved = 0;
        ++w.nextNonce;
        w.state = State.Released;
        w.repairDecisionId = a.decisionId;
        w.repairSnapshotHash = a.snapshotHash;
        w.repairHash = a.repairHash;
        balance[a.workflowId][r.recipient] += amount;
        // The audit event retains the decision; reservedDebit remains the historical settled debit.
        emit RepairReleased(a.workflowId, a.decisionId, a.repairHash, r.recipient, amount);
    }

    /// @notice Idempotent expiration, permissionless and independent of guardian pause.
    function refundExpired(bytes32 workflowId) external nonReentrant {
        _expire(workflowId);
    }

    function withdraw(bytes32 workflowId) external nonReentrant {
        _withdraw(workflowId, msg.sender);
    }

    function withdrawFor(bytes32 workflowId, address beneficiary) external nonReentrant {
        _withdraw(workflowId, beneficiary);
    }

    function pause(bool value) external nonReentrant {
        if (msg.sender != guardian) {
            revert Unauthorized();
        }
        paused = value;
        emit PauseChanged(value);
    }

    function getWorkflow(bytes32 workflowId) external view returns (Workflow memory) {
        return workflows[workflowId];
    }

    function getAccount(bytes32 workflowId, address agent)
        external
        view
        returns (uint256 cap, uint256 deposited, uint256 credit, uint256 debit, uint256 withdrawable)
    {
        Workflow storage w = workflows[workflowId];
        cap = bondCap[workflowId][agent];
        deposited = originalDeposit[workflowId][agent];
        credit = balance[workflowId][agent];
        debit = reservedDebit[workflowId][agent];
        if (w.state == State.Released || w.state == State.Expired) {
            withdrawable = credit;
        } else if (w.state == State.Reserved && block.timestamp >= w.repairDeadline) {
            withdrawable = credit + debit;
        } else if (w.state != State.Missing && block.timestamp >= w.hardDeadline) {
            withdrawable = credit;
        }
    }

    function getTerms(bytes32 workflowId)
        external
        view
        returns (
            address[] memory agents,
            bytes32[] memory nodeIds,
            uint8[] memory nodeAgents,
            RepairAction[] memory repairs
        )
    {
        return (
            agentsByWorkflow[workflowId],
            nodesByWorkflow[workflowId],
            nodeAgentsByWorkflow[workflowId],
            repairsByWorkflow[workflowId]
        );
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("FaultlineBondEscrow"), keccak256("1"), block.chainid, address(this))
        );
    }

    function hashActivation(ActivationAuthorization calldata a) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(ACTIVATION_TYPEHASH, a)));
    }

    function hashReservation(ReservationAuthorization calldata a) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(RESERVATION_TYPEHASH, a)));
    }

    function hashRelease(ReleaseAuthorization calldata a) public view returns (bytes32) {
        return _digest(keccak256(abi.encode(RELEASE_TYPEHASH, a)));
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _live(Workflow storage w, State expected) private view {
        if (w.state != expected) {
            revert WrongState();
        }
        if (block.timestamp >= w.hardDeadline) {
            revert DeadlinePassed();
        }
    }

    function _binding(
        Workflow storage w,
        bytes32 workflowHash,
        bytes32 termsHash,
        uint256 sourceChain,
        address sourceContract,
        uint256 nonce,
        uint256 expiry
    ) private view {
        if (
            workflowHash != w.workflowHash || termsHash != w.termsHash || sourceChain != w.genlayerChainId
                || sourceContract != w.genlayerContract || nonce != w.nextNonce || block.timestamp >= expiry
                || expiry > w.hardDeadline
        ) {
            revert InvalidAuthorization();
        }
    }

    function _signature(bytes32 digest, bytes calldata signature) private view {
        if (signature.length != 65) {
            revert InvalidSignature();
        }
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (
            uint256(r) == 0 || uint256(s) == 0 || uint256(s) > HALF_ORDER || (v != 27 && v != 28)
                || ecrecover(digest, v, r, s) != attestor
        ) {
            revert InvalidSignature();
        }
    }

    function _repair(bytes32 workflowId, bytes32 id) private view returns (RepairAction memory) {
        RepairAction[] storage repairs = repairsByWorkflow[workflowId];
        for (uint256 i; i < repairs.length; ++i) {
            if (repairs[i].id == id) {
                return repairs[i];
            }
        }
        revert InvalidAuthorization();
    }

    function _reserveDebits(bytes32 id, uint8[] calldata classes, RepairAction memory r) private {
        uint8[] storage owners = nodeAgentsByWorkflow[id];
        address[] storage agents = agentsByWorkflow[id];
        if (classes.length != owners.length) {
            revert InvalidClasses();
        }
        uint256[] memory weights = new uint256[](agents.length);
        uint256 total;
        for (uint256 i; i < classes.length; ++i) {
            uint8 c = classes[i];
            if (c > 4) {
                revert InvalidClasses();
            }
            uint256 weight = c == 1 ? 3 : c == 2 ? 1 : 0;
            weights[owners[i]] += weight;
            total += weight;
        }
        if (total == 0) {
            revert InvalidClasses();
        }
        uint256[] memory debits = new uint256[](agents.length);
        uint256 allocated;
        for (uint256 i; i < agents.length; ++i) {
            if (agents[i] == r.recipient && weights[i] != 0) {
                revert LiableRepairer();
            }
            debits[i] = r.price * weights[i] / total;
            allocated += debits[i];
        }
        uint256 remainder = r.price - allocated;
        for (uint256 i; i < agents.length; ++i) {
            if (remainder != 0 && weights[i] != 0) {
                ++debits[i];
                --remainder;
            }
            // Checked even though price <= repairCap <= EVERY bond guarantees the cap.
            if (debits[i] > bondCap[id][agents[i]] || debits[i] > balance[id][agents[i]]) {
                revert InvalidTerms();
            }
            reservedDebit[id][agents[i]] = debits[i];
            balance[id][agents[i]] -= debits[i];
        }
        assert(remainder == 0);
    }

    function _expire(bytes32 id) private {
        Workflow storage w = workflows[id];
        if (w.state == State.Expired) {
            return;
        }
        if (w.state == State.Missing || w.state == State.Released) {
            revert WrongState();
        }
        uint256 deadline = w.state == State.Reserved ? w.repairDeadline : w.hardDeadline;
        if (block.timestamp < deadline) {
            revert NotMature();
        }
        if (w.state == State.Reserved) {
            address[] storage agents = agentsByWorkflow[id];
            for (uint256 i; i < agents.length; ++i) {
                address agent = agents[i];
                balance[id][agent] += reservedDebit[id][agent];
                reservedDebit[id][agent] = 0;
            }
            w.reserved = 0;
        }
        w.state = State.Expired;
        emit WorkflowExpired(id);
    }

    function _withdraw(bytes32 id, address beneficiary) private {
        Workflow storage w = workflows[id];
        if (w.state != State.Released && w.state != State.Expired) {
            _expire(id);
        }
        uint256 amount = balance[id][beneficiary];
        if (amount == 0) {
            revert NothingToWithdraw();
        }
        balance[id][beneficiary] = 0;
        totalLiability -= amount;
        _transferExact(address(this), beneficiary, amount);
        emit Withdrawn(id, beneficiary, amount);
    }

    function _transferExact(address from, address to, uint256 amount) private {
        uint256 beforeFrom = IERC20Balance(USDC).balanceOf(from);
        uint256 beforeTo = IERC20Balance(USDC).balanceOf(to);
        bytes memory data = from == address(this)
            ? abi.encodeWithSelector(bytes4(keccak256("transfer(address,uint256)")), to, amount)
            : abi.encodeWithSelector(bytes4(keccak256("transferFrom(address,address,uint256)")), from, to, amount);
        (bool ok, bytes memory result) = USDC.call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || abi.decode(result, (uint256)) != 1))) {
            revert TransferFailed();
        }
        uint256 afterFrom = IERC20Balance(USDC).balanceOf(from);
        uint256 afterTo = IERC20Balance(USDC).balanceOf(to);
        if (
            afterFrom > beforeFrom || beforeFrom - afterFrom != amount || afterTo < beforeTo
                || afterTo - beforeTo != amount
        ) {
            revert InexactTransfer();
        }
    }
}
